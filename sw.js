/* Moonlight PWA — service worker (v1-4-1)
   Принципы:
   - Установка МГНОВЕННАЯ: при install качаем только index.html (~0.5МБ) и то
     с таймаутом — никакой предзагрузки 3МБ картинок (в v1-4-0 из-за неё на
     слабой сети установка висла, SW не активировался и кэш вообще не работал).
   - Картинки/видео кэшируются ПО МЕРЕ ИСПОЛЬЗОВАНИЯ (fetch ниже): что юзер
     открыл — то и сохранилось, дальше отдаётся мгновенно и офлайн.
   - HTML: кэш-первым, свежая версия тихо качается в фоне на следующий раз.
   - index.html кладём в кэш ТОЛЬКО целиком: проверяем, что в тексте есть
     метка конца файла (__ML_DONE). Обрезанная сетью страница в кэш не попадёт.
   - Видео из кэша отдаём кусками (206 Range) — иначе iPhone его не играет.
   - Supabase и чужие домены не трогаем.
   Чтобы форсировать обновление у всех — поднимите номер версии. */
var CACHE = "moonlight-v1-4-1";
var INDEX_KEY = "./index.html";
var END_MARK = "__ML_DONE";

function fetchWithTimeout(req, ms){
  return new Promise(function(resolve, reject){
    var t = setTimeout(function(){ reject(new Error("timeout")); }, ms);
    fetch(req).then(function(r){ clearTimeout(t); resolve(r); },
                    function(e){ clearTimeout(t); reject(e); });
  });
}

/* Кладём index.html в кэш только если он ЦЕЛЫЙ (есть метка конца файла). */
function putIndexIfComplete(c, res){
  if(!res || !res.ok) return Promise.resolve(false);
  var forCheck = res.clone(), forCache = res.clone();
  return forCheck.text().then(function(t){
    if(t.indexOf(END_MARK) < 0) return false;          // обрезан — не кэшируем
    return c.put(INDEX_KEY, forCache).then(function(){ return true; });
  }).catch(function(){ return false; });
}

self.addEventListener("install", function(e){
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(function(c){
      // только index.html, с таймаутом; не получилось — не страшно,
      // закэшируется при первой же удачной навигации (см. fetch)
      return fetchWithTimeout(INDEX_KEY, 20000)
        .then(function(res){ return putIndexIfComplete(c, res); })
        .catch(function(){});
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

/* Ответ на Range-запрос (видео) из целиком закэшированного файла:
   вырезаем нужный кусок и отдаём 206 — так видео играет и на iPhone. */
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
  // Только наш собственный домен. Supabase/realtime/CDN — мимо service worker.
  if(url.origin !== self.location.origin) return;

  var accept = req.headers.get("accept") || "";
  var isNav = req.mode === "navigate" || accept.indexOf("text/html") >= 0;
  var cacheKey = isNav ? INDEX_KEY : req;
  var hasRange = !!req.headers.get("range");

  e.respondWith(
    caches.match(cacheKey, { ignoreVary: true }).then(function(cached){

      // Range-запрос (видео) и файл есть в кэше целиком — отдаём кусок сами
      if(cached && hasRange && !isNav){
        return rangeResponse(req, cached.clone());
      }

      var netUpdate = fetch(req).then(function(res){
        if(res && res.ok && !hasRange){
          caches.open(CACHE).then(function(c){
            if(isNav) putIndexIfComplete(c, res.clone());   // HTML — только целый
            else { try { c.put(cacheKey, res.clone()); } catch(err){} }
          });
        }
        return res;
      }).catch(function(){ return null; });

      if(cached){
        // Есть сохранённая копия — отдаём мгновенно, сеть обновит кэш в фоне.
        netUpdate.catch(function(){});
        return cached;
      }
      // Кэша ещё нет — ждём сеть (первый запуск на этом устройстве).
      return netUpdate.then(function(res){
        return res || (isNav ? caches.match(INDEX_KEY) : undefined) ||
          new Response("", { status: 504 });
      });
    })
  );
});
