/* Moonlight PWA — service worker
   Цель: приложение запускается МГНОВЕННО из кэша и НЕ зависает на нестабильной
   сети (VPN/iOS). Логика:
   - HTML (навигация): сначала сеть с таймаутом 3 сек → значит онлайн всегда свежая
     версия; если сеть висит/недоступна → отдаём последнюю сохранённую из кэша.
   - Своя статика (иконки и т.п.): сначала кэш, обновление в фоне.
   - Supabase и сторонние домены (CDN) НЕ трогаем — проходят напрямую.
   Чтобы заставить обновиться после правок — поднимите номер версии ниже. */
var CACHE = "moonlight-v1-1-2";
/* При установке кэшируем только мелочь. САМ index.html (3.7МБ) при установке
   НЕ скачиваем повторно — он ляжет в кэш при первой же навигации (см. fetch ниже).
   Раньше из-за двойной параллельной закачки первый запуск зависал (белый экран). */
var SHELL = ["./apple-touch-icon.png"];

self.addEventListener("install", function(e){
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(function(c){ return c.addAll(SHELL).catch(function(){}); })
  );
});

self.addEventListener("activate", function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.map(function(k){ if(k !== CACHE) return caches.delete(k); }));
    }).then(function(){ return self.clients.claim(); })
  );
});

function netWithTimeout(req, ms){
  return new Promise(function(resolve, reject){
    var done = false;
    var t = setTimeout(function(){ if(!done){ done = true; reject(new Error("timeout")); } }, ms);
    fetch(req).then(function(res){ if(!done){ done = true; clearTimeout(t); resolve(res); } })
              .catch(function(err){ if(!done){ done = true; clearTimeout(t); reject(err); } });
  });
}

/* ===== PUSH: показ уведомления при закрытом приложении ===== */
self.addEventListener("push", function(e){
  var data = {};
  try { data = e.data ? e.data.json() : {}; }
  catch(err){ data = { title: "Moonlight 🌙", body: (e.data && e.data.text()) || "" }; }
  var title = data.title || "Moonlight 🌙";
  e.waitUntil(self.registration.showNotification(title, {
    body: data.body || "",
    icon: "apple-touch-icon.png",
    badge: "apple-touch-icon.png",
    tag: data.tag || "ml-push",
    data: { url: data.url || "./" }
  }));
});

/* Тап по уведомлению: открываем/фокусируем приложение */
self.addEventListener("notificationclick", function(e){
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(function(list){
      for(var i=0;i<list.length;i++){ if("focus" in list[i]) return list[i].focus(); }
      if(clients.openWindow) return clients.openWindow("./");
    })
  );
});

self.addEventListener("fetch", function(e){
  var req = e.request;
  if(req.method !== "GET") return;

  var url;
  try { url = new URL(req.url); } catch(err){ return; }
  // Только наш собственный домен. Supabase/realtime/CDN — мимо service worker.
  if(url.origin !== self.location.origin) return;

  var accept = req.headers.get("accept") || "";
  var isNav = req.mode === "navigate" || accept.indexOf("text/html") >= 0;

  if(isNav){
    e.respondWith(
      netWithTimeout(req, 3000).then(function(res){
        try {
          var copy = res.clone();
          caches.open(CACHE).then(function(c){ c.put("./index.html", copy); });
        } catch(err){}
        return res;
      }).catch(function(){
        return caches.match(req).then(function(m){ return m || caches.match("./index.html"); });
      })
    );
    return;
  }

  // Прочая своя статика: кэш-первым, обновление в фоне.
  e.respondWith(
    caches.match(req).then(function(m){
      var net = fetch(req).then(function(res){
        try { var copy = res.clone(); caches.open(CACHE).then(function(c){ c.put(req, copy); }); } catch(err){}
        return res;
      }).catch(function(){ return m; });
      return m || net;
    })
  );
});
