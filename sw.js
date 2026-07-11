/* Moonlight PWA — service worker
   Логика: КЭШ-ПЕРВЫМ для всего своего (HTML, картинки, видео) — открывается
   мгновенно и работает офлайн; свежая версия тихо качается в фоне и появится
   при следующем запуске. Supabase и сторонние домены идут напрямую.
   Чтобы заставить обновиться после правок — поднимите номер версии ниже.

   С версии 1-4-0 приложение разрезано на части: index.html ~0.5МБ + папка
   assets/ (картинки и видео отдельными файлами). Теперь обрыв мобильной сети
   не роняет всё приложение: логика доезжает быстро, а тяжёлые файлы качаются
   независимо и докэшируются по мере успеха. */
var CACHE = "moonlight-v1-4-0";
/* При установке заранее кэшируем ВСЁ приложение (теперь это безопасно: файлы
   маленькие и качаются по отдельности). Каждый файл — независимо: если какой-то
   не докачался, остальные всё равно лягут в кэш, а неудачник докэшируется
   при первом обращении (см. fetch ниже). */
var SHELL = [
  "./index.html",
  "./apple-touch-icon.png",
  "./assets/about.jpg",
  "./assets/app-bg.jpg",
  "./assets/care-avoid.jpg",
  "./assets/care-cream.jpg",
  "./assets/care-first.jpg",
  "./assets/care-worry.jpg",
  "./assets/entrance.jpg",
  "./assets/img01.jpg",
  "./assets/img02.jpg",
  "./assets/img03.jpg",
  "./assets/img04.jpg",
  "./assets/img05.jpg",
  "./assets/img06.jpg",
  "./assets/img07.jpg",
  "./assets/img08.jpg",
  "./assets/img09.jpg",
  "./assets/img10.jpg",
  "./assets/img11.jpg",
  "./assets/img12.jpg",
  "./assets/img13.jpg",
  "./assets/img14.jpg",
  "./assets/img15.jpg",
  "./assets/img16.jpg",
  "./assets/img17.jpg",
  "./assets/img18.jpg",
  "./assets/img19.jpg",
  "./assets/img20.jpg",
  "./assets/login-bg.mp4"
];

self.addEventListener("install", function(e){
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(function(c){
      return Promise.all(SHELL.map(function(u){ return c.add(u).catch(function(){}); }));
    })
  );
});

self.addEventListener("activate", function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.map(function(k){ if(k !== CACHE) return caches.delete(k); }));
    }).then(function(){ return self.clients.claim(); })
  );
});

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

// Кэш-первым для ЛЮБОГО GET-запроса на нашем домене (и HTML-навигация, и статика):
// если в кэше уже есть полностью сохранённая копия — отдаём её сразу целиком,
// а свежую версию докачиваем в фоне (появится при следующем открытии). Только если
// в кэше пусто (самый первый визит) — ждём сеть, деваться некуда.
self.addEventListener("fetch", function(e){
  var req = e.request;
  if(req.method !== "GET") return;

  var url;
  try { url = new URL(req.url); } catch(err){ return; }
  // Только наш собственный домен. Supabase/realtime/CDN — мимо service worker.
  if(url.origin !== self.location.origin) return;

  var accept = req.headers.get("accept") || "";
  var isNav = req.mode === "navigate" || accept.indexOf("text/html") >= 0;
  var cacheKey = isNav ? "./index.html" : req;

  e.respondWith(
    caches.match(cacheKey).then(function(cached){
      var netUpdate = fetch(req).then(function(res){
        if(res && res.ok){
          try {
            var copy = res.clone();
            caches.open(CACHE).then(function(c){ c.put(cacheKey, copy); });
          } catch(err){}
        }
        return res;
      }).catch(function(err){ return null; });

      if(cached){
        // Есть что показать прямо сейчас — отдаём мгновенно. Сеть в фоне сама
        // обновит кэш к следующему разу, текущий показ она уже не трогает.
        netUpdate.catch(function(){});
        return cached;
      }
      // Кэша ещё нет — приходится дождаться сеть (первый запуск на этом устройстве).
      return netUpdate.then(function(res){ return res || caches.match("./index.html"); });
    })
  );
});
