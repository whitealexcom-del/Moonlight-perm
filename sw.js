/* Moonlight PWA — service worker
   Цель: приложение запускается МГНОВЕННО из кэша и НЕ зависает на нестабильной
   сети (VPN/iOS, мобильный интернет). Логика:
   - HTML (навигация): КЭШ-ПЕРВЫМ — если уже есть сохранённая копия, показываем её
     сразу и целиком (мгновенно, без риска показать недогруженную страницу), а свежую
     версию тихо подтягиваем в фоне — она появится при следующем открытии.
     Если кэша ещё нет (самый первый заход) — приходится ждать сеть.
   - Своя статика (иконки и т.п.): та же логика — кэш-первым, обновление в фоне.
   - Supabase и сторонние домены (CDN) НЕ трогаем — проходят напрямую.
   Чтобы заставить обновиться после правок — поднимите номер версии ниже.

   ВАЖНО: index.html весит ~3.9МБ (все картинки зашиты внутрь base64). Раньше страница
   грузилась "сеть-первым" с таймаутом на несколько секунд — на нестабильном мобильном
   интернете загрузка обрывалась на середине (браузер успевал отрисовать только кусок
   страницы, например экран входа, а до остального — то есть до всей логики — соединение
   не доходило), из-за этого видели то чёрный экран, то "мелькнувший" экран входа без
   продолжения. Кэш-первым полностью убирает этот риск: пользователь ВСЕГДА видит либо
   полностью загруженную (и один раз успешно сохранённую) версию, либо честно ждёт сеть
   при самом первом запуске. */
var CACHE = "moonlight-v1-3-4";
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
