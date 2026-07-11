/* Moonlight PWA — service worker (v1-4-2)
   Проблема, которую решает эта версия: на рваной сети (DPI/VPN, GitHub Pages
   из РФ) страница часто обрывается на середине скачивания. При этом УДАЧНО
   скачанная копия лежит в HTTP-кэше браузера, но в кэш приложения не попадала:
   самая первая загрузка происходит до того, как SW берёт страницу под контроль.
   Решение:
   - забираем index.html из HTTP-кэша браузера (cache:"force-cache") — это
     мгновенно и без сети; сеть — только запасной вариант (с повторами);
   - страница после успешного запуска шлёт сообщение "cacheIndex" — SW тут же
     сохраняет её копию (см. постмессадж внизу index.html);
   - в кэш принимается ТОЛЬКО целый index (метка __ML_DONE в конце файла);
   - видео из кэша отдаём кусками (206 Range) — для iPhone;
   - Supabase и чужие домены не трогаем. */
var CACHE = "moonlight-v1-4-2";
var INDEX_KEY = "./index.html";
var END_MARK = "__ML_DONE";

/* Проверка целостности + запись в кэш. Возвращает true при успехе. */
function putIndexIfComplete(c, res){
  if(!res || !res.ok) return Promise.resolve(false);
  var forCheck = res.clone(), forCache = res.clone();
  return forCheck.text().then(function(t){
    if(t.indexOf(END_MARK) < 0) return false;          // обрезан — не кэшируем
    return c.put(INDEX_KEY, forCache).then(function(){ return true; });
  }).catch(function(){ return false; });
}

/* Достаём ЦЕЛЫЙ index.html любым способом, от дешёвого к дорогому:
   1) HTTP-кэш браузера для "./" и "./index.html" (мгновенно, без сети);
   2) сеть, до 2 попыток.
   Первый целый экземпляр кладём в кэш приложения. */
function harvestIndex(){
  return caches.open(CACHE).then(function(c){
    function tryOne(mk){
      return mk().then(function(res){ return putIndexIfComplete(c, res); })
                 .catch(function(){ return false; });
    }
    var attempts = [
      function(){ return fetch("./", { cache: "force-cache" }); },
      function(){ return fetch(INDEX_KEY, { cache: "force-cache" }); },
      function(){ return fetch(INDEX_KEY, { cache: "no-cache" }); },
      function(){ return fetch(INDEX_KEY, { cache: "no-cache" }); }
    ];
    var p = Promise.resolve(false);
    attempts.forEach(function(mk){
      p = p.then(function(done){ return done ? true : tryOne(mk); });
    });
    return p;
  });
}

self.addEventListener("install", function(e){
  self.skipWaiting();
  e.waitUntil(harvestIndex().catch(function(){}));
});

self.addEventListener("activate", function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.map(function(k){ if(k !== CACHE) return caches.delete(k); }));
    }).then(function(){ return self.clients.claim(); })
  );
});

/* Страница сообщает: «я успешно запустилась — сохрани меня» */
self.addEventListener("message", function(e){
  if(e.data === "cacheIndex"){
    e.waitUntil(harvestIndex().catch(function(){}));
  }
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

self.addEventListener("notificationclick", function(e){
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(function(list){
      for(var i=0;i<list.length;i++){ if("focus" in list[i]) return list[i].focus(); }
      if(clients.openWindow) return clients.openWindow("./");
    })
  );
});

/* Range-запрос (видео) из целиком закэшированного файла — отдаём кусок 206 */
function rangeResponse(req, cached){
  var h = req.headers.get("range") || "";
  var m = /bytes=(\d+)-(\d*)/.exec(h);
  if(!m) return cached;
  return cached.arrayBuffer().then(function(buf){
    var start = +m[1];
    var end = m[2] ? Math.min(+m[2], buf.byteLength - 1) : buf.byteLength - 1;
    if(start >= buf.byteLength) return new Response(null, { status: 416 });
    var chunk = buf.slice(start, end + 1);
    return new Response(chunk, {
      status: 206,
      statusText: "Partial Content",
      headers: {
        "Content-Type": cached.headers.get("Content-Type") || "video/mp4",
        "Content-Range": "bytes " + start + "-" + end + "/" + buf.byteLength,
        "Content-Length": String(chunk.byteLength),
        "Accept-Ranges": "bytes"
      }
    });
  });
}

self.addEventListener("fetch", function(e){
  var req = e.request;
  if(req.method !== "GET") return;

  var url;
  try { url = new URL(req.url); } catch(err){ return; }
  if(url.origin !== self.location.origin) return;

  var accept = req.headers.get("accept") || "";
  var isNav = req.mode === "navigate" || accept.indexOf("text/html") >= 0;
  var cacheKey = isNav ? INDEX_KEY : req;
  var hasRange = !!req.headers.get("range");

  e.respondWith(
    caches.match(cacheKey, { ignoreVary: true }).then(function(cached){

      if(cached && hasRange && !isNav){
        return rangeResponse(req, cached.clone());
      }

      var netUpdate = fetch(req).then(function(res){
        if(res && res.ok && !hasRange){
          caches.open(CACHE).then(function(c){
            if(isNav) putIndexIfComplete(c, res.clone());
            else { try { c.put(cacheKey, res.clone()); } catch(err){} }
          });
        }
        return res;
      }).catch(function(){ return null; });

      if(cached){
        netUpdate.catch(function(){});
        return cached;
      }
      // Кэша нет: параллельно с ожиданием сети пробуем добыть целый index
      // из HTTP-кэша (если он там есть — следующая загрузка будет мгновенной).
      if(isNav) e.waitUntil(harvestIndex().catch(function(){}));
      return netUpdate.then(function(res){
        return res || (isNav ? caches.match(INDEX_KEY) : undefined) ||
          new Response("", { status: 504 });
      });
    })
  );
});
