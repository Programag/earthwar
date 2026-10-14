// Test E2E w prawdziwej przeglądarce (Playwright + Chromium).
// Zewnętrzne serwery (GUGiK, Esri, OSM) są podmieniane w przeglądarce na wygenerowane kafle,
// więc test sprawdza dokładnie te adresy URL, które wysyła aplikacja (m.in. BBOX każdego kafla).
//
//   node test/e2e.mjs            (wymaga globalnie zainstalowanego pakietu `playwright`)
//   SHOT_DIR=/sciezka node test/e2e.mjs   (zapis zrzutów ekranu)
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const { chromium } = require(path.join(execSync('npm root -g').toString().trim(), 'playwright'));
const PAGE = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html')).href;
const SHOTS = process.env.SHOT_DIR;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

/* ---------- wygenerowane kafle PNG ---------- */
function png(fn) {
  const W = 256, raw = Buffer.alloc((W * 4 + 1) * W);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const o = y * (W * 4 + 1) + 1 + x * 4, [r, g, b, a] = fn(x, y);
    raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
  }
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(zlib.crc32(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const edge = (x, y) => x === 0 || y === 0;
const TILES = {
  esri: png((x, y) => edge(x, y) ? [20, 40, 20, 255] : [50 + (x >> 2), 110 + (y >> 3), 60, 255]),
  osm: png((x, y) => edge(x, y) ? [90, 80, 60, 255] : [230, 224, 205, 255]),
  relief: png((x, y) => edge(x, y) ? [0, 0, 0, 255] : [(x + y) >> 1, (x + y) >> 1, (x + y) >> 1, 255]),
  labels: png((x, y) => (y % 32 < 3 && x > 40 && x < 200) ? [255, 255, 255, 255] : [0, 0, 0, 0]),
  custom: png((x, y) => edge(x, y) ? [80, 0, 80, 255] : [170, 60, 190, 255]),
};

/* ---------- mini-asercje ---------- */
let failed = 0, passed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log('  ok   ' + name); } else { failed++; console.log('  FAIL ' + name + (detail ? '  → ' + detail : '')); }
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ORIGIN = 20037508.342789244;
const bboxToTile = (bbox) => { const [x0, , , y1] = bbox.split(',').map(Number); const size = bbox.split(',').map(Number)[2] - x0; return { z: Math.round(Math.log2(2 * ORIGIN / size)), x: Math.round((x0 + ORIGIN) / size), y: Math.round((ORIGIN - y1) / size) }; };

/* ---------- przeglądarka z podmienionymi serwerami ---------- */
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
const log = { esri: [], osm: [], wms: [], elev: [], custom: [], other: [] };
const mode = { gugikFail: false, esriFail: false, delay: 0, failFirst: 0, attempts: new Map(), noJpeg: false };   // failFirst: tyle pierwszych prób każdego kafla GUGiK kończy się błędem 500   // delay: opóźnienie odpowiedzi GUGiK [ms]
const CORS = { 'access-control-allow-origin': '*' };
await ctx.route(/^https?:/, async (route) => {
  const u = new URL(route.request().url());
  if (mode.delay && u.host === 'mapy.geoportal.gov.pl') await sleep(mode.delay);
  const fulfill = (body, type = 'image/png', status = 200) => route.fulfill({ status, body, contentType: type, headers: CORS });
  if (u.host === 'server.arcgisonline.com') {
    log.esri.push(u);
    if (mode.esriFail) return fulfill('boom', 'text/plain', 500);
    return fulfill(u.pathname.includes('/Reference/') ? TILES.labels : TILES.esri);
  }
  if (u.host === 'tile.openstreetmap.org') { log.osm.push(u); return fulfill(TILES.osm); }
  if (u.host === 'mapy.geoportal.gov.pl') {
    log.wms.push(u);
    if (mode.failFirst) {
      const sp = new URLSearchParams(u.search); sp.delete('_retry');
      const k = u.pathname + '?' + sp, n = (mode.attempts.get(k) || 0) + 1;
      mode.attempts.set(k, n);
      if (n <= mode.failFirst) return fulfill('boom', 'text/plain', 500);
    }
    if (mode.noJpeg && u.pathname.includes('/NMT/') && u.searchParams.get('FORMAT') === 'image/jpeg') return fulfill('<ServiceExceptionReport><ServiceException code="InvalidFormat"/></ServiceExceptionReport>', 'text/xml');
    return mode.gugikFail ? fulfill('boom', 'text/plain', 500) : fulfill(TILES.relief);
  }
  if (u.host === 'services.gugik.gov.pl') { log.elev.push(u); return fulfill('123.4', 'text/plain'); }
  if (u.host === 'example.test') {
    if (/GetCapabilities/i.test(u.search)) return fulfill('<?xml version="1.0"?><WMS_Capabilities xmlns="http://www.opengis.net/wms"><Capability><Layer><Title>root</Title><Layer><Name>slope</Name></Layer><Layer><Name>aspect</Name></Layer></Layer></Capability></WMS_Capabilities>', 'text/xml');
    log.custom.push(u); return fulfill(TILES.custom);
  }
  log.other.push(u.href); return route.abort();
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
const shot = async (name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
const ev = (fn, arg) => page.evaluate(fn, arg);
const settle = async (ms = 400) => { await sleep(ms); await ev(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))); };
const view = () => ev(() => ({ z: LidarPL.map.z, lat: LidarPL.map.center.lat, lng: LidarPL.map.center.lng }));
const tileKey = (u) => { const [z, y, x] = u.pathname.split('/').slice(-3); return `${z}/${x}/${y}`; };
const isImagery = (u) => u.pathname.includes('/World_Imagery/');
const isLabels = (u) => u.pathname.includes('/Reference/World_Boundaries_and_Places/');
const llAt = (x, y) => ev(([x, y]) => LidarPL.map.containerToLL(x, y), [x, y]);

/* =========================================================== */
console.log('\n[1] Start i kafle');
await page.goto(PAGE);
await settle(800);
let v = await view();
check('widok startowy: Kraków, zoom 12', near(v.z, 12, 1e-9) && near(v.lat, 50.0647, 1e-6) && near(v.lng, 19.945, 1e-6), JSON.stringify(v));
const esriSet = new Set(log.esri.filter(isImagery).map(tileKey));
const labelSet = new Set(log.esri.filter(isLabels).map(tileKey));
const wmsHill = log.wms.filter((u) => u.pathname.endsWith('/NMT/GRID1/WMS/ShadedRelief') && u.searchParams.get('WIDTH') === '512');   // bez zgrubnych podglądów (256 px)
const wmsSet = new Set(wmsHill.map((u) => { const t = bboxToTile(u.searchParams.get('BBOX')); return `${t.z}/${t.x}/${t.y}`; }));
check('pobrano kafle Esri', esriSet.size >= 4, `n=${esriSet.size}`);
check('pobrano kafle ShadedRelief (WMS)', wmsSet.size >= 2, `n=${wmsSet.size}`);
check('pobrano kafle z nazwami miejscowości (Esri Reference) dla tego samego widoku', labelSet.size === esriSet.size && [...esriSet].every((k) => labelSet.has(k)), `img=${esriSet.size} labels=${labelSet.size}`);
const parentKey = (k) => { const [z, x, y] = k.split('/').map(Number); return `${z - 1}/${x >> 1}/${y >> 1}`; };
check('BBOX kafli WMS (512 px) dokładnie pokrywa kafle XYZ tego samego widoku (1 kafel WMS = 2×2 XYZ)', [...esriSet].every((k) => wmsSet.has(parentKey(k))) && [...wmsSet].every((k) => [...esriSet].some((e) => parentKey(e) === k)), `esri=${[...esriSet]} wms=${[...wmsSet]}`);
const p = wmsHill[0].searchParams;
check('parametry WMS 1.3.0 / EPSG:3857 / 512px',
  p.get('SERVICE') === 'WMS' && p.get('VERSION') === '1.3.0' && p.get('REQUEST') === 'GetMap' && p.get('LAYERS') === 'Raster' &&
  p.get('CRS') === 'EPSG:3857' && p.get('WIDTH') === '512' && p.get('HEIGHT') === '512' && p.get('FORMAT') === 'image/jpeg' && p.get('TRANSPARENT') === 'FALSE',
  wmsHill[0].search);
const cover = await ev(() => {
  const w = innerWidth, h = innerHeight;
  const rects = [...LidarPL.map.layers.find((l) => l.zIndex === 1).el.querySelectorAll('.tile.ok')].map((i) => i.getBoundingClientRect());
  return [[1, 1], [w - 2, 1], [1, h - 2], [w - 2, h - 2], [w / 2, h / 2]].every(([x, y]) => rects.some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom));
});
check('kafle podkładu pokrywają cały ekran', cover);
check('status reliefu: wczytano kafle', /Wczytano kafli/.test(await page.textContent('#reliefStatus')), await page.textContent('#reliefStatus'));
check('brak nieoczekiwanych zapytań zewnętrznych', log.other.length === 0, log.other.join(', '));
await shot('01-start');

console.log('\n[2] Gesty: przeciąganie, kółko, przyciski, klawiatura');
{
  const before = await llAt(700, 400);
  await page.mouse.move(700, 400); await page.mouse.down(); await page.mouse.move(640, 370, { steps: 5 }); await page.mouse.move(560, 330, { steps: 5 }); await page.mouse.up();
  await settle(150);
  const after = await llAt(560, 330);
  check('przeciąganie: punkt pod kursorem pozostaje ten sam', near(before.lat, after.lat, 1e-7) && near(before.lng, after.lng, 1e-7), `${JSON.stringify(before)} vs ${JSON.stringify(after)}`);
  const z0 = (await view()).z;
  const anchor = await llAt(800, 300);
  await page.mouse.move(800, 300); await page.mouse.wheel(0, -100); await settle(150);
  const z1 = (await view()).z, anchor2 = await llAt(800, 300);
  check('kółko myszy przybliża (0,5 poziomu na „ząbek”)', near(z1 - z0, 0.5, 1e-9), `dz=${z1 - z0}`);
  check('zoom kółkiem trzyma punkt pod kursorem', near(anchor.lat, anchor2.lat, 1e-7) && near(anchor.lng, anchor2.lng, 1e-7));
  await page.click('#zin'); await settle(100);
  check('przycisk + zaokrągla do pełnego poziomu (12,5 → 13)', near((await view()).z, 13, 1e-9), String((await view()).z));
  await page.click('#zout'); await settle(100);
  check('przycisk − oddala o poziom', near((await view()).z, 12, 1e-9));
  await page.focus('#map'); const c0 = await view(); await page.keyboard.press('ArrowLeft'); await settle(100);
  const c1 = await view();
  check('klawisz ← przesuwa mapę na zachód', c1.lng < c0.lng && near(c1.lat, c0.lat, 1e-6), `${c0.lng} → ${c1.lng}`);
  await page.keyboard.press('+'); await settle(100);
  check('klawisz + przybliża', near((await view()).z, 13, 1e-9));
}

console.log('\n[3] Zmiana warstw, przezroczystość, hash');
{
  await page.evaluate(() => LidarPL.map.setView(50.0647, 19.945, 15));
  await settle(600);
  const n0 = log.wms.length;
  await page.check('input[name=relief][value=skyview]'); await settle(600);
  check('SkyView: zapytania do usługi SkyView', log.wms.slice(n0).some((u) => u.pathname.endsWith('/NMT/GRID1/WMS/SkyView') && u.searchParams.get('LAYERS') === 'Raster'));
  const nOrtho = log.wms.length;
  await page.check('input[name=base][value=ortho]'); await settle(600);
  const ortho = log.wms.slice(nOrtho).filter((u) => u.pathname.endsWith('/ORTO/WMS/StandardResolution'));
  check('Ortofotomapa GUGiK: JPEG, bez przezroczystości', ortho.length > 0 && ortho[0].searchParams.get('FORMAT') === 'image/jpeg' && ortho[0].searchParams.get('TRANSPARENT') === 'FALSE', ortho[0]?.search);
  await page.check('input[name=base][value=osm]'); await settle(400);
  check('OpenStreetMap: kafle z tile.openstreetmap.org', log.osm.length > 0);
  await page.check('input[name=base][value=esri]'); await settle(300);
  await page.evaluate(() => { const o = document.querySelector('#opacity'); o.value = 40; o.dispatchEvent(new Event('input')); });
  check('suwak przezroczystości ustawia krycie warstwy reliefu', await ev(() => LidarPL.map.layers.find((l) => l.zIndex === 2).el.style.opacity === '0.4'));
  check('etykieta suwaka', (await page.textContent('#opacityOut')) === '40%');
  const hash = await ev(() => location.hash);
  check('hash URL odzwierciedla widok', /^#15\.00\/50\.0\d+\/19\.9\d+$/.test(hash), hash);
  await page.check('input[name=relief][value=none]'); await settle(200);
  check('„Brak” usuwa warstwę reliefu', await ev(() => !LidarPL.map.layers.some((l) => l.zIndex === 2)));
  await page.check('input[name=relief][value=hillshade]'); await settle(500);
  await shot('02-krakow-hillshade');
}

console.log('\n[4] Tryb porównania (suwak)');
{
  await page.click('.seg button[data-mode=swipe]'); await settle(150);
  const clip = () => ev(() => LidarPL.map.layers.find((l) => l.zIndex === 2).el.style.clipPath);
  check('clip-path ustawiony na środek ekranu', /inset\(0px 0px 0px 640px\)/.test(await clip()), await clip());
  check('w trybie porównania krycie reliefu = 100%, suwak wyłączony', await ev(() => LidarPL.map.layers.find((l) => l.zIndex === 2).el.style.opacity === '1' && document.querySelector('#opacity').disabled));
  await page.mouse.move(640, 400); await page.mouse.down(); await page.mouse.move(900, 400, { steps: 6 }); await page.mouse.up(); await settle(100);
  check('przeciągnięcie uchwytu przesuwa linię podziału', /inset\(0px 0px 0px 900px\)/.test(await clip()), await clip());
  await shot('03-swipe');
  await page.click('.seg button[data-mode=blend]'); await settle(100);
  check('powrót do mieszania: brak clip-path, krycie 40%', await ev(() => LidarPL.map.layers.find((l) => l.zIndex === 2).el.style.clipPath === '' && LidarPL.map.layers.find((l) => l.zIndex === 2).el.style.opacity === '0.4'));
}

console.log('\n[5] Punkty, GPX/KML, trwałość');
{
  await page.evaluate(() => LidarPL.map.setView(50.0647, 19.945, 14)); await settle(200);
  const expectA = await llAt(700, 300), expectB = await llAt(800, 450);
  await page.click('#btnAdd');
  await page.mouse.click(700, 300); await page.mouse.click(800, 450);
  await settle(100);
  check('dwa kliknięcia w trybie dodawania = 2 punkty', (await ev(() => LidarPL.markers.length)) === 2);
  check('po dodaniu otwiera się okienko z nazwą', await page.isVisible('.popup'));
  await page.fill('.popup input', 'Kopiec <A&B>');
  await page.keyboard.press('Escape');
  check('Esc zamyka okienko i kończy tryb dodawania', !(await page.isVisible('.popup')) && !(await ev(() => document.querySelector('#map').classList.contains('adding'))));
  check('znaczniki są w DOM', (await page.locator('.mk').count()) === 2);
  const m = await ev(() => LidarPL.markers.map(({ lat, lon, name }) => ({ lat, lon, name })));
  check('współrzędne punktu = miejsce kliknięcia', near(m[0].lat, expectA.lat, 1e-7) && near(m[0].lng ?? m[0].lon, expectA.lng, 1e-7) && near(m[1].lat, expectB.lat, 1e-7));
  check('nazwa zapisana (domyślna i własna)', m[0].name === 'Punkt 1' && m[1].name === 'Kopiec <A&B>', JSON.stringify(m.map((x) => x.name)));
  const mkPos = await page.locator('.mk').first().boundingBox();
  check('znacznik leży w punkcie kliknięcia (±1 px)', near(mkPos.x, 700, 1) && near(mkPos.y, 300, 1), JSON.stringify(mkPos));
  await shot('04-markers');

  await page.reload(); await settle(600);
  const m2 = await ev(() => LidarPL.markers.map(({ lat, lon, name }) => ({ lat, lon, name })));
  check('punkty przetrwały odświeżenie (localStorage)', m2.length === 2 && m2[1].name === 'Kopiec <A&B>');

  const [dlG] = await Promise.all([page.waitForEvent('download'), page.click('#btnGpx')]);
  const gpx = fs.readFileSync(await dlG.path(), 'utf8');
  check('eksport GPX: nazwa pliku i struktura', /^punkty-lidar-\d{8}\.gpx$/.test(dlG.suggestedFilename()) && (gpx.match(/<wpt /g) || []).length === 2 && gpx.includes('<name>Kopiec &lt;A&amp;B&gt;</name>'), gpx);
  const gm = /<wpt lat="([\d.-]+)" lon="([\d.-]+)">/.exec(gpx);
  check('eksport GPX: lat/lon poprawnie', near(+gm[1], m2[0].lat, 1e-6) && near(+gm[2], m2[0].lon, 1e-6));
  const [dlK] = await Promise.all([page.waitForEvent('download'), page.click('#btnKml')]);
  const kml = fs.readFileSync(await dlK.path(), 'utf8');
  const km = /<coordinates>([\d.-]+),([\d.-]+),0<\/coordinates>/.exec(kml);
  check('eksport KML: kolejność lon,lat', km && near(+km[1], m2[0].lon, 1e-6) && near(+km[2], m2[0].lat, 1e-6), kml);

  page.once('dialog', (d) => d.accept());
  await page.click('#btnClear'); await settle(100);
  check('Wyczyść usuwa wszystkie punkty (po potwierdzeniu)', (await ev(() => LidarPL.markers.length)) === 0 && (await page.locator('.mk').count()) === 0);
  check('przyciski eksportu wyłączone przy braku punktów', await page.isDisabled('#btnGpx') && await page.isDisabled('#btnKml'));

  await page.setInputFiles('#fileIn', { name: 'a.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(gpx.replace('</gpx>', '<trk><trkseg><trkpt lat="50" lon="19"/></trkseg></trk></gpx>')) });
  await settle(200);
  check('import GPX: 2 punkty, ślad pominięty', (await ev(() => LidarPL.markers.length)) === 2 && /pominięto.*: 1/.test(await page.textContent('#markerInfo')), await page.textContent('#markerInfo'));
  check('import przywraca nazwę z pliku', (await ev(() => LidarPL.markers[1].name)) === 'Kopiec <A&B>');
  const kmlIn = `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>
    <Placemark><name>Fosa</name><Point><coordinates>17.7458,52.7967,0</coordinates></Point></Placemark>
    <Placemark><name>Droga</name><LineString><coordinates>17,52,0 17.1,52.1,0</coordinates></LineString></Placemark></Document></kml>`;
  await page.setInputFiles('#fileIn', { name: 'b.kml', mimeType: 'application/vnd.google-earth.kml+xml', buffer: Buffer.from(kmlIn) });
  await settle(200);
  const fosa = await ev(() => LidarPL.markers.find((x) => x.name === 'Fosa'));
  check('import KML: punkt trafia we właściwe miejsce (lon,lat)', fosa && near(fosa.lat, 52.7967, 1e-9) && near(fosa.lon, 17.7458, 1e-9));
  check('import KML: linia pominięta', (await ev(() => LidarPL.markers.length)) === 3 && /pominięto.*: 1/.test(await page.textContent('#markerInfo')));
  await page.setInputFiles('#fileIn', { name: 'c.gpx', mimeType: 'text/xml', buffer: Buffer.from('to nie jest XML <<<') });
  await settle(100);
  check('import: komunikat dla niepoprawnego pliku', /Nie rozpoznano/.test(await page.textContent('#markerInfo')) && (await ev(() => LidarPL.markers.length)) === 3);
  await page.click('#btnUndo'); await settle(50);
  check('Cofnij ostatni usuwa ostatnio dodany punkt', (await ev(() => LidarPL.markers.length)) === 2 && !(await ev(() => LidarPL.markers.some((x) => x.name === 'Fosa'))));
  await page.click('.mk i >> nth=0'); await settle(50);
  await page.click('.popup button');
  check('Usuń punkt w okienku działa', (await ev(() => LidarPL.markers.length)) === 1);
}

console.log('\n[6] Współrzędne i wysokość');
{
  await page.evaluate(() => LidarPL.map.setView(52.2297, 21.0122, 12)); await settle(300);
  log.elev.length = 0;
  await page.mouse.move(640, 400); await page.mouse.move(641, 401); await settle(700);
  const txt = await page.textContent('#coords');
  check('okienko pokazuje φ/λ i PL-1992', /φ 52\.\d{5}\s+λ 21\.\d{5}/.test(txt) && /PL-1992\s+X 4\d{5}\s+Y 6\d{5}/.test(txt), txt);
  check('wysokość z usługi GUGiK', /Wysokość: 123\.4 m n\.p\.m\./.test(txt), txt);
  const q = log.elev.at(-1)?.searchParams;
  const ll = await llAt(641, 401), pl = await ev(([a, b]) => LidarPL.toPL1992(a, b), [ll.lat, ll.lng]);
  check('zapytanie: x = północ, y = wschód (PL-1992)', q && near(+q.get('x'), pl.n, 0.01) && near(+q.get('y'), pl.e, 0.01) && q.get('request') === 'GetHbyXY', log.elev.at(-1)?.search);
  await page.evaluate(() => LidarPL.map.setView(48.0, 10.0, 8)); await settle(200);
  const nElev = log.elev.length;
  await page.mouse.move(700, 450); await page.mouse.move(702, 452); await settle(600);
  check('poza Polską: bez zapytania o wysokość', log.elev.length === nElev && /poza Polską/.test(await page.textContent('#coords')), await page.textContent('#coords'));
}

console.log('\n[7] Błędy serwera GUGiK');
{
  await page.evaluate(() => LidarPL.map.setView(53.0, 18.0, 13)); await settle(300);
  mode.gugikFail = true;
  await page.check('input[name=relief][value=none]'); await page.check('input[name=relief][value=hillshade]'); await settle(3200);   // 3 próby: 0 + 0,5 s + 1,2 s
  const st = await page.textContent('#reliefStatus');
  check('status ostrzega, gdy serwer nie zwraca kafli', /Serwer nie zwrócił kafli/.test(st), st);
  mode.gugikFail = false;
  await page.check('input[name=relief][value=none]'); await page.check('input[name=relief][value=hillshade]'); await settle(700);
  check('po naprawie serwera status wraca do „Wczytano”', /Wczytano kafli/.test(await page.textContent('#reliefStatus')));
}

console.log('\n[8] Własne źródło WMS');
{
  await page.evaluate(() => LidarPL.map.setView(50.0647, 19.945, 14)); await settle(200);
  await page.click('details summary');
  await page.fill('#cwUrl', 'https://example.test/wms');
  await page.click('#cwCaps'); await settle(300);
  const opts = await page.$$eval('#cwLayerList option', (o) => o.map((x) => x.value));
  check('„Pobierz listę warstw” parsuje GetCapabilities', opts.join() === 'slope,aspect', opts.join());
  await page.fill('#cwName', 'Nachylenie (test)'); await page.fill('#cwLayers', 'slope'); await page.selectOption('#cwVersion', '1.1.1');
  await page.click('#cwForm button[type=submit]'); await settle(600);
  const cu = log.custom.find((u) => u.pathname === '/wms' && !/GetCapabilities/i.test(u.search));
  check('nowe źródło pojawia się na liście i jest wybrane', await page.isChecked('input[name=relief][value^=custom-]'));
  check('WMS 1.1.1 używa SRS=EPSG:3857 i podanej warstwy', cu && cu.searchParams.get('VERSION') === '1.1.1' && cu.searchParams.get('SRS') === 'EPSG:3857' && cu.searchParams.get('LAYERS') === 'slope' && !cu.searchParams.has('CRS'), cu?.search);
  await page.reload(); await settle(600);
  check('własne źródło przetrwało odświeżenie i jest aktywne', await page.isChecked('input[name=relief][value^=custom-]'));
  await page.click('#reliefList .x'); await settle(300);
  check('usunięcie własnego źródła', (await page.locator('input[name=relief][value^=custom-]').count()) === 0 && await ev(() => !LidarPL.map.layers.some((l) => l.zIndex === 2)));
}

console.log('\n[9] Hash startowy, PL-1992, telefon');
{
  await page.goto('about:blank');
  await page.goto(PAGE + '#12.00/50.06470/19.94500'); await settle(300);
  v = await view();
  check('zimny start z hasha #zoom/lat/lon', near(v.z, 12, 1e-9) && near(v.lat, 50.0647, 1e-6) && near(v.lng, 19.945, 1e-6), JSON.stringify(v));
  await ev(() => { location.hash = '#10.00/52.00000/19.00000'; }); await settle(200);
  v = await view();
  check('zmiana hasha w otwartej karcie przesuwa mapę', near(v.z, 10, 1e-9) && near(v.lat, 52, 1e-6) && near(v.lng, 19, 1e-6), JSON.stringify(v));
  const REF = [[52.0, 19.0, 500000.000, 459309.210], [52.2297, 21.0122, 637382.204, 486757.210], [50.0647, 19.945, 567613.619, 244587.532], [54.352, 18.6466, 477037.599, 720936.521], [49.2992, 19.9496, 569017.966, 159512.042], [53.4285, 14.5528, 204684.704, 627375.024]];
  for (const [lat, lon, E, N] of REF) {
    const r = await ev(([a, b]) => LidarPL.toPL1992(a, b), [lat, lon]);
    check(`PL-1992 (${lat}, ${lon}) zgodne z niezależną implementacją (<1 mm)`, near(r.e, E, 0.001) && near(r.n, N, 0.001), `${r.e.toFixed(3)} ${r.n.toFixed(3)} vs ${E} ${N}`);
  }
  const bb = await ev(() => LidarPL.tileBBox3857(0, 0, 0));
  check('BBOX kafla 0/0/0 = cały świat EPSG:3857', near(bb[0], -ORIGIN, 1e-6) && near(bb[3], ORIGIN, 1e-6));

  const mob = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });
  await mob.route(/^https?:/, (r) => r.fulfill({ body: TILES.esri, contentType: 'image/png' }));
  const mp = await mob.newPage();
  await mp.goto(PAGE); await sleep(500);
  check('telefon: panel domyślnie zwinięty, widać przycisk ☰', !(await mp.isVisible('#panel')) && await mp.isVisible('#panelToggle'));
  await mp.screenshot({ path: SHOTS ? path.join(SHOTS, '05-mobile-map.png') : undefined });
  await mp.tap('#panelToggle'); await sleep(200);
  check('telefon: ☰ otwiera panel', await mp.isVisible('#panel'));
  const noOverflow = await mp.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  check('telefon: brak poziomego przewijania', noOverflow);
  if (SHOTS) await mp.screenshot({ path: path.join(SHOTS, '06-mobile-panel.png') });
  await mob.close();
}

console.log('\n[10] Nazwy miejscowości, próg przybliżenia, mnożenie, lista miast, diagnostyka podkładu');
{
  await page.goto('about:blank');
  await page.goto(PAGE + '#12.00/50.06470/19.94500'); await settle(300);
  await page.check('input[name=relief][value=hillshade]'); await settle(500);   // stan z poprzednich sekcji: „Brak”
  const hasLayer = (z) => ev((z) => LidarPL.map.layers.some((l) => l.zIndex === z), z);
  const style = (z, prop) => ev(([z, prop]) => getComputedStyle(LidarPL.map.layers.find((l) => l.zIndex === z).el)[prop], [z, prop]);

  // nazwy miejscowości
  check('nazwy miejscowości: warstwa nad reliefem (z-index 3), pole zaznaczone', await hasLayer(3) && await page.isChecked('#labelsChk'));
  await page.uncheck('#labelsChk'); await settle(100);
  check('odznaczenie ukrywa nazwy', !(await hasLayer(3)));
  await page.check('#labelsChk'); await settle(300);
  check('zaznaczenie przywraca nazwy', await hasLayer(3));
  await page.check('input[name=base][value=osm]'); await settle(200);
  check('OSM ma własne podpisy: nazwy Esri wyłączone, pole nieaktywne', !(await hasLayer(3)) && await page.isDisabled('#labelsChk'));
  await page.check('input[name=base][value=esri]'); await settle(300);
  check('powrót na Esri przywraca nazwy', await hasLayer(3) && !(await page.isDisabled('#labelsChk')));
  await page.evaluate(() => LidarPL.map.setView(50.0647, 19.945, 13)); await settle(600); await shot('07-labels-multiply');   // kafle z13 ruszają ok. 0,15 s po zmianie zoomu

  // próg przybliżenia reliefu
  let n0 = log.wms.length;
  await page.evaluate(() => LidarPL.map.setView(52.0, 19.0, 8)); await settle(500);
  const farReq = log.wms.slice(n0).filter((u) => u.pathname.endsWith('/ShadedRelief'));
  check('poniżej progu (z8): brak zapytań o relief, warstwa ukryta', farReq.length === 0 && (await style(2, 'visibility')) === 'hidden', `zapytań: ${farReq.length} ${farReq.slice(0, 3).map((u) => u.search.slice(0, 120)).join(' | ')}; visibility=${await style(2, 'visibility')}`);
  check('poniżej progu: podpowiedź zamiast „szarej strony”', /ukryty przy tym oddaleniu \(widoczny od poziomu 10\)/.test(await page.textContent('#reliefStatus')), await page.textContent('#reliefStatus'));
  check('poniżej progu nazwy miejscowości nadal widać', await hasLayer(3) && (await style(3, 'visibility')) !== 'hidden');
  await page.evaluate(() => LidarPL.map.setView(52.0, 19.0, 9.4)); await settle(300);
  check('z9,4 (zaokrągla do 9): nadal ukryty', (await style(2, 'visibility')) === 'hidden');
  n0 = log.wms.length;
  await page.evaluate(() => LidarPL.map.setView(52.0, 19.0, 9.6)); await settle(500);
  check('z9,6 (zaokrągla do 10): relief pobierany', log.wms.slice(n0).some((u) => u.pathname.endsWith('/ShadedRelief')) && (await style(2, 'visibility')) === 'visible');
  check('po przybliżeniu status wraca do „Wczytano”', /Wczytano kafli/.test(await page.textContent('#reliefStatus')), await page.textContent('#reliefStatus'));

  // mnożenie
  check('domyślnie relief jest mieszany przez mnożenie', (await style(2, 'mixBlendMode')) === 'multiply' && await page.isChecked('#multChk'));
  await page.uncheck('#multChk'); await settle(100);
  check('odznaczenie mnożenia: zwykłe krycie', (await style(2, 'mixBlendMode')) === 'normal');
  await page.check('#multChk');
  await page.click('.seg button[data-mode=swipe]'); await settle(100);
  check('tryb porównania: bez mnożenia, pole nieaktywne', (await style(2, 'mixBlendMode')) === 'normal' && await page.isDisabled('#multChk'));
  await page.click('.seg button[data-mode=blend]'); await settle(100);
  check('powrót do mieszania przywraca mnożenie', (await style(2, 'mixBlendMode')) === 'multiply' && !(await page.isDisabled('#multChk')));

  // lista miast
  await page.selectOption('#jump', { label: 'Gdańsk' }); await settle(200);
  v = await view();
  check('lista miast: Gdańsk, zoom 13', near(v.z, 13, 1e-9) && near(v.lat, 54.352, 1e-6) && near(v.lng, 18.6466, 1e-6), JSON.stringify(v));
  check('lista wraca do „Wybierz…”', (await page.inputValue('#jump')) === '');
  const cities = await page.$$eval('#jump option', (o) => o.map((x) => x.textContent));
  check('na liście są największe miasta', ['Warszawa', 'Kraków', 'Wrocław', 'Poznań', 'Gdańsk', 'Zakopane'].every((c) => cities.includes(c)), cities.join(', '));

  // diagnostyka podkładu: serwer Esri nie odpowiada
  mode.esriFail = true;
  await page.check('input[name=base][value=osm]'); await page.check('input[name=base][value=esri]'); await settle(3200);   // 3 próby: 0 + 0,5 s + 1,2 s
  check('gdy podkład się nie wczytuje, panel to pokazuje', /Podkład nie wczytał żadnych kafli/.test(await page.textContent('#baseStatus')), await page.textContent('#baseStatus'));
  await shot('08-base-failure');
  mode.esriFail = false;
  await page.check('input[name=base][value=osm]'); await page.check('input[name=base][value=esri]'); await settle(700);
  check('po naprawie ostrzeżenie znika', (await page.textContent('#baseStatus')) === '');
}

console.log('\n[11] Pasek ładowania');
{
  await page.goto('about:blank');
  await page.goto(PAGE + '#13.00/50.06470/19.94500'); await settle(300);
  await page.check('input[name=relief][value=hillshade]'); await settle(600);
  const loader = () => ev(() => ({
    on: document.querySelector('#loader').classList.contains('on') && document.querySelector('#loadTxt').classList.contains('on'),
    w: document.querySelector('#loader i').style.width, txt: document.querySelector('#loadTxt').textContent,
    now: +document.querySelector('#loader').getAttribute('aria-valuenow'), busy: document.querySelector('#map').getAttribute('aria-busy'),
    load: { ...LidarPL.map.loading },
  }));
  let a = await loader();
  check('po wczytaniu wszystkiego pasek jest ukryty, a licznik wyzerowany', !a.on && a.busy !== 'true' && a.load.pending === 0 && a.load.total === 0, JSON.stringify(a));

  mode.delay = 1800;   // relief z GUGiK odpowiada wolno, Esri szybko
  await page.evaluate(() => LidarPL.map.setView(54.352, 18.6466, 13));
  await sleep(700);
  a = await loader();
  check('podczas wolnego ładowania pasek jest widoczny', a.on && a.busy === 'true' && a.load.pending > 0, JSON.stringify(a));
  check('postęp jest częściowy (0 < % < 100) i opisany tekstem', a.now > 0 && a.now < 100 && /^Ładowanie mapy… \d+% \(\d+\/\d+\)$/.test(a.txt), JSON.stringify(a));
  check('szerokość paska odpowiada postępowi', near(parseFloat(a.w), Math.max(a.now, 4), 0.5), `${a.w} vs ${a.now}`);
  await shot('09-loading');
  await sleep(2600);
  a = await loader();
  check('po dojściu wszystkich kafli pasek znika', !a.on && a.busy === 'false' && a.load.pending === 0, JSON.stringify(a));
  check('pasek doszedł do 100% przed ukryciem', a.now === 100, String(a.now));

  mode.delay = 800;   // szybkie ruchy: kafle są anulowane w locie
  for (let i = 0; i < 5; i++) { await page.evaluate((i) => LidarPL.map.setView(50 + i * 0.7, 19 + i * 0.7, 12 + (i % 2) * 2), i); await sleep(90); }
  await sleep(2200);
  a = await loader();
  check('po szybkich ruchach (anulowane kafle) nic nie „wisi”', !a.on && a.load.pending === 0 && a.load.total === 0 && a.load.done === 0, JSON.stringify(a));

  mode.delay = 0; mode.esriFail = true;   // błędy też kończą ładowanie
  await page.evaluate(() => LidarPL.map.setView(53.0, 22.0, 13)); await sleep(3200);
  a = await loader();
  check('kafle zakończone błędem nie blokują paska', !a.on && a.load.pending === 0, JSON.stringify(a));
  mode.esriFail = false;
}

console.log('\n[12] Podróż: oddalenie z Krakowa, przesunięcie do Warszawy, przybliżenie');
{
  await page.goto('about:blank');
  await page.goto(PAGE + '#12.00/50.06470/19.94500'); await settle(300);
  await page.check('input[name=relief][value=hillshade]'); await settle(300);
  mode.delay = 300;   // wolny serwer GUGiK
  const reliefState = () => ev(() => {
    const l = LidarPL.map.layers.find((x) => x.zIndex === 2);
    const imgs = [...l.el.querySelectorAll('.tile')];
    const ok = imgs.filter((i) => i.classList.contains('ok'));
    const w = innerWidth, h = innerHeight;
    const rects = ok.map((i) => i.getBoundingClientRect());
    const covered = [[w * 0.45, h * 0.3], [w * 0.9, h * 0.5], [w * 0.6, h * 0.9], [w / 2, h / 2]].every(([x, y]) => rects.some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom));
    return { z: LidarPL.map.z, hidden: getComputedStyle(l.el).visibility === 'hidden', tiles: imgs.length, ok: ok.length, covered, pending: LidarPL.map.loading.pending, zooms: [...new Set(l.tiles.values().map((t) => t.z))] };
  });
  await settle(1200);
  let st = await reliefState();
  check('Kraków z12: relief wczytany i pokrywa widok', !st.hidden && st.ok > 0 && st.covered, JSON.stringify(st));

  for (let i = 0; i < 10; i++) { await page.mouse.move(700, 400); await page.mouse.wheel(0, 100); await sleep(60); }
  await settle(500);
  st = await reliefState();
  check('po oddaleniu (z7) relief jest zdjęty, a nie zostawia starych kafli', st.z < 8 && st.hidden && st.tiles === 0, JSON.stringify(st));

  // przeciągnięcie Warszawy na środek ekranu
  const wp = await ev(() => LidarPL.map.llToContainer(52.2297, 21.0122));
  await page.mouse.move(wp.x, wp.y); await page.mouse.down(); await page.mouse.move(700, 400, { steps: 8 }); await page.mouse.up(); await settle(200);
  const n0 = log.wms.length;
  for (let i = 0; i < 10; i++) { await page.mouse.move(700, 400); await page.mouse.wheel(0, -100); await sleep(60); }
  await settle(2500);
  st = await reliefState();
  v = await view();
  check('przy Warszawie z12: środek widoku to Warszawa', near(v.z, 12, 1e-9) && near(v.lat, 52.2297, 0.05) && near(v.lng, 21.0122, 0.05), JSON.stringify(v));
  check('relief dla Warszawy jest pobrany, widoczny i pokrywa widok', !st.hidden && st.ok > 0 && st.covered && st.pending === 0, JSON.stringify(st));
  const req = log.wms.slice(n0).filter((u) => u.pathname.endsWith('/ShadedRelief')).map((u) => bboxToTile(u.searchParams.get('BBOX')));
  const finalImg = await ev(() => LidarPL.map.layers.find((l) => l.zIndex === 1)).catch(() => null);
  const needed = await ev(() => [...LidarPL.map.layers.find((l) => l.zIndex === 1).tiles.keys()]);
  const reqKeys = new Set(req.map((t) => `${t.z}/${t.x}/${t.y}`));
  const parentOf = (k) => { const [z, x, y] = k.split('/').map(Number); return `${z - 1}/${x >> 1}/${y >> 1}`; };
  check('zapytania o relief obejmują wszystkie kafle widoku Warszawy', needed.length > 0 && needed.every((k) => reqKeys.has(parentOf(k))), `brakuje: ${needed.filter((k) => !reqKeys.has(parentOf(k))).join(', ')}`);
  check('w warstwie nie zostały kafle z innego poziomu (stare)', st.zooms.length === 1 && st.zooms[0] === 11, JSON.stringify(st.zooms));   // siatka 512 px dla z12 = poziom 11
  mode.delay = 0;
  await shot('10-warszawa');
}

console.log('\n[13] Wskazówka o ukrytym reliefie, próg przybliżenia, ponawianie kafli');
{
  await page.goto('about:blank');
  await page.goto(PAGE + '#12.00/52.22970/21.01220'); await settle(300);
  await page.check('input[name=relief][value=hillshade]'); await settle(600);
  const chip = () => ev(() => { const e = document.querySelector('#zoomHint'); return { on: getComputedStyle(e).display !== 'none', txt: e.textContent }; });
  const rel = () => ev(() => { const l = LidarPL.map.layers.find((x) => x.zIndex === 2); return { ok: l.el.querySelectorAll('.tile.ok').length, stats: { ...l.stats }, hidden: getComputedStyle(l.el).visibility === 'hidden' }; });
  check('relief widoczny: wskazówki brak', !(await chip()).on);

  await page.evaluate(() => LidarPL.map.setView(52.2297, 21.0122, 8)); await settle(300);
  let c = await chip();
  check('po oddaleniu na mapie pojawia się wskazówka z progiem', c.on && /ukryty przy tym oddaleniu \(widoczny od poziomu 10\)/.test(c.txt), JSON.stringify(c));
  await shot('11-hint');
  let n0 = log.wms.length;
  await page.click('#zoomHintBtn'); await settle(900);
  v = await view();
  check('„Przybliż” przechodzi do progu i pobiera relief', near(v.z, 10, 1e-9) && log.wms.slice(n0).some((u) => u.pathname.endsWith('/ShadedRelief')) && !(await chip()).on && (await rel()).ok > 0, JSON.stringify(v));

  await page.selectOption('#minZoom', '7');
  await page.evaluate(() => LidarPL.map.setView(52.2297, 21.0122, 7.2)); await settle(800);
  check('próg 7: relief widoczny już na z7,2, bez wskazówki', !(await chip()).on && (await rel()).ok > 0 && !(await rel()).hidden, JSON.stringify(await rel()));
  await page.selectOption('#minZoom', '12');
  await page.evaluate(() => LidarPL.map.setView(52.2297, 21.0122, 11)); await settle(300);
  c = await chip();
  check('próg 12: na z11 relief ukryty, wskazówka podaje 12', c.on && /od poziomu 12\)/.test(c.txt) && (await rel()).hidden, JSON.stringify(c));
  await page.reload(); await settle(500);
  check('próg przetrwał odświeżenie strony', (await page.inputValue('#minZoom')) === '12');
  await page.selectOption('#minZoom', '10');

  // ponawianie: serwer odrzuca 2 pierwsze próby każdego kafla, trzecia przechodzi
  mode.failFirst = 2; mode.attempts.clear();
  n0 = log.wms.length;
  await page.evaluate(() => LidarPL.map.setView(51.1079, 17.0385, 13)); await sleep(700);
  const mid = await ev(() => ({ pending: LidarPL.map.loading.pending, on: document.querySelector('#loadTxt').classList.contains('on') }));
  check('w trakcie ponawiania kafle są „w toku” (pasek ładowania działa)', mid.pending > 0 && mid.on, JSON.stringify(mid));
  await settle(3500);
  const r = await rel();
  const retries = log.wms.slice(n0).map((u) => u.searchParams.get('_retry'));
  check('chwilowe błędy: kafle ostatecznie się wczytały', r.ok > 0 && r.stats.err === 0, JSON.stringify(r));
  check('ponowienia mają parametr _retry=1 i _retry=2', retries.includes('1') && retries.includes('2'), [...new Set(retries)].join(','));
  check('status: „Wczytano”, bez ostrzeżenia', /Wczytano kafli/.test(await page.textContent('#reliefStatus')), await page.textContent('#reliefStatus'));

  // błąd trwały (więcej niż liczba ponowień) kończy się ostrzeżeniem
  mode.failFirst = 3; mode.attempts.clear();
  await page.evaluate(() => LidarPL.map.setView(54.352, 18.6466, 13)); await settle(3500);
  check('błąd trwały: po ponowieniach ostrzeżenie dotyczy tego, co jest w widoku (nie liczy starych kafli)', /Serwer nie zwrócił kafli/.test(await page.textContent('#reliefStatus')), await page.textContent('#reliefStatus'));
  mode.failFirst = 0;
}

console.log('\n[14] Szybkość ładowania: liczba zapytań, kolejność, zoom kółkiem, pomiar czasu');
{
  const R = 6378137;
  const merc = (lat, lng) => ({ x: R * lng * Math.PI / 180, y: R * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) });
  const bb = (u) => u.searchParams.get('BBOX').split(',').map(Number);
  const contains = (b, m) => m.x >= b[0] && m.x <= b[2] && m.y >= b[1] && m.y <= b[3];
  const relief = (u) => u.pathname.endsWith('/ShadedRelief');
  const center = merc(50.0647, 19.945);

  // --- start: liczba zapytań i kolejność
  await page.goto('about:blank');
  await page.selectOption('#minZoom', '10').catch(() => {});
  const w0 = log.wms.length, e0 = log.esri.length;
  await page.goto(PAGE + '#12.00/50.06470/19.94500'); await settle(1500);
  const wms = log.wms.slice(w0).filter((u) => relief(u) && u.searchParams.get('WIDTH') === '512'), img = log.esri.slice(e0).filter(isImagery);
  console.log(`  info  start z12: zapytań o relief = ${wms.length}, kafli podkładu (256 px) = ${img.length}`);
  check('relief pobierany większymi kafelkami (512 px) = kilka razy mniej zapytań', wms.length > 0 && wms.every((u) => u.searchParams.get('WIDTH') === '512' && u.searchParams.get('HEIGHT') === '512') && wms.length * 3 <= img.length, `${wms.length} vs ${img.length}`);
  const dW = (u) => { const b = bb(u); return Math.hypot((b[0] + b[2]) / 2 - center.x, (b[1] + b[3]) / 2 - center.y); };
  check('najpierw pobierany jest kafel najbliższy środka widoku (relief)', wms.length > 0 && dW(wms[0]) <= Math.min(...wms.map(dW)) + 1e-6, wms.map((u) => Math.round(dW(u))).join(','));
  const dI = (u) => { const [z, x, y] = tileKey(u).split('/').map(Number), n = 2 ** z, size = 2 * ORIGIN / n; return Math.hypot(-ORIGIN + (x + 0.5) * size - center.x, ORIGIN - (y + 0.5) * size - center.y); };
  check('najpierw pobierany jest kafel najbliższy środka widoku (podkład)', img.length > 0 && dI(img[0]) <= Math.min(...img.map(dI)) + 1e-6, img.map((u) => Math.round(dI(u))).join(','));

  // --- szybki zoom kółkiem: bez burzy zapytań
  await page.selectOption('#minZoom', '6');
  await page.evaluate(() => LidarPL.map.setView(50.0647, 19.945, 13)); await settle(800);
  mode.delay = 300;
  const n0 = log.wms.length;
  for (let i = 0; i < 8; i++) { await page.mouse.move(700, 400); await page.mouse.wheel(0, 100); await sleep(50); }
  const during = log.wms.length - n0;
  console.log(`  info  zoom kółkiem z13 → z9: zapytań w trakcie gestu = ${during}`);
  check('w trakcie zoomu kółkiem nie pobieramy kafli pośrednich poziomów', during === 0, `zapytań: ${during}`);
  await settle(1500);
  const after = log.wms.slice(n0).filter((u) => relief(u) && u.searchParams.get('WIDTH') === '512').map((u) => bboxToTile(u.searchParams.get('BBOX')));
  const zs = new Set(after.map((t) => t.z));
  console.log(`  info  po zakończeniu gestu: zapytań = ${after.length}, poziomy = ${[...zs]}`);
  check('po zatrzymaniu pobierany jest tylko jeden (docelowy) poziom i rozsądna liczba kafli', zs.size === 1 && after.length > 0 && after.length <= 16, JSON.stringify([...zs]) + ' n=' + after.length);
  v = await view();
  check('po gestzie wczytany relief pokrywa widok', (await ev(() => { const l = LidarPL.map.layers.find((x) => x.zIndex === 2); const r = [...l.el.querySelectorAll('.tile.ok')].map((i) => i.getBoundingClientRect()); return [[700, 300], [900, 500], [500, 600], [1100, 200]].every(([x, y]) => r.some((q) => x >= q.left && x <= q.right && y >= q.top && y <= q.bottom)); })), JSON.stringify(v));

  // --- pomiar czasu kafli widoczny w panelu
  mode.delay = 400;
  await page.evaluate(() => LidarPL.map.setView(52.2297, 21.0122, 12)); await settle(2500);
  let st = await page.textContent('#reliefStatus');
  check('panel podaje średni czas kafla reliefu', /Wczytano kafli: \d+ · średnio 0,[4-9] s/.test(st), st);
  mode.delay = 2800;
  await page.evaluate(() => LidarPL.map.setView(51.1079, 17.0385, 12)); await settle(5000);
  st = await page.textContent('#reliefStatus');
  check('przy wolnym serwerze panel mówi to wprost', /serwer odpowiada wolno/.test(st) && /średnio [2-9],\d s/.test(st), st);
  mode.delay = 0;
  await page.selectOption('#minZoom', '10');
}

console.log('\n[15] Format JPEG i wycofanie do PNG, zgrubne podglądy');
{
  const relief = (u) => u.pathname.endsWith('/ShadedRelief');
  const fine = (u) => relief(u) && u.searchParams.get('WIDTH') === '512';
  const coarse = (u) => relief(u) && u.searchParams.get('WIDTH') === '256';
  const layerInfo = () => ev(() => {
    const l = LidarPL.map.layers.find((x) => x.zIndex === 2);
    return { stats: l.stats, domOk: l.el.querySelectorAll('.tile.ok').length, zooms: [...new Set([...l.tiles.values()].map((t) => t.z))], useAlt: l.useAlt };
  });

  // --- start: tanie podglądy idą pierwsze
  await page.goto('about:blank');
  let n = log.wms.length;
  await page.goto(PAGE + '#12.00/50.06470/19.94500'); await settle(1500);
  let rq = log.wms.slice(n).filter(relief);
  const zOf = (u) => bboxToTile(u.searchParams.get('BBOX')).z;
  console.log(`  info  start: podglądów 256 px = ${rq.filter(coarse).length}, kafli 512 px = ${rq.filter(fine).length}`);
  check('na starcie najpierw idą zgrubne podglądy', rq.length > 0 && coarse(rq[0]), rq.map((u) => u.searchParams.get('WIDTH')).join(','));
  check('podglądy są tanie: 1–4 zapytania na cały widok, 2 poziomy rzadsza siatka', rq.filter(coarse).length >= 1 && rq.filter(coarse).length <= 4 && rq.filter(coarse).every((u) => zOf(u) === zOf(rq.find(fine)) - 2), rq.map((u) => zOf(u)).join(','));
  check('relief to JPEG bez przezroczystości', rq.filter(fine).every((u) => u.searchParams.get('FORMAT') === 'image/jpeg' && u.searchParams.get('TRANSPARENT') === 'FALSE'));
  let li = await layerInfo();
  check('po wczytaniu szczegółów podglądy znikają (jeden poziom siatki)', li.zooms.length === 1 && li.zooms[0] === 11, JSON.stringify(li));
  check('liczniki w panelu nie liczą podglądów', li.stats.ok === li.domOk && li.stats.err === 0, JSON.stringify(li));
  const cov = await ev(() => { const l = LidarPL.map.layers.find((x) => x.zIndex === 2); const r = [...l.el.querySelectorAll('.tile.ok')].map((i) => i.getBoundingClientRect()); return [[700, 300], [900, 500], [500, 600], [1100, 200]].every(([x, y]) => r.some((q) => x >= q.left && x <= q.right && y >= q.top && y <= q.bottom)); });
  check('szczegóły pokrywają widok po zniknięciu podglądów', cov);

  // --- podglądy tylko wtedy, gdy nic nie jest wczytane
  n = log.wms.length;
  await page.mouse.move(900, 400); await page.mouse.down(); await page.mouse.move(780, 380, { steps: 6 }); await page.mouse.up(); await settle(900);
  check('zwykłe przesunięcie nie tworzy podglądów', log.wms.slice(n).filter(coarse).length === 0);
  n = log.wms.length;
  await page.click('#zin'); await settle(900);
  check('zmiana powiększenia nie tworzy podglądów (stare kafle są podkładem)', log.wms.slice(n).filter(coarse).length === 0);
  n = log.wms.length;
  await page.evaluate(() => LidarPL.map.setView(52.2297, 21.0122, 13)); await settle(1500);
  rq = log.wms.slice(n).filter(relief);
  check('skok w inne miejsce: znowu najpierw podglądy', rq.length > 0 && coarse(rq[0]), rq.map((u) => u.searchParams.get('WIDTH')).join(','));
  li = await layerInfo();
  check('po skoku podglądy też znikają, a liczniki się zgadzają', li.zooms.length === 1 && li.stats.ok === li.domOk, JSON.stringify(li));

  // --- serwer nie obsługuje JPEG: automatyczne wycofanie do PNG
  mode.noJpeg = true;
  await page.goto('about:blank');
  n = log.wms.length;
  await page.goto(PAGE + '#12.00/51.10790/17.03850'); await settle(3000);
  rq = log.wms.slice(n).filter(relief);
  const fmt = (u) => u.searchParams.get('FORMAT');
  li = await layerInfo();
  check('JPEG odrzucony: kafle i tak się wczytały (PNG)', li.stats.ok > 0 && li.stats.err === 0 && rq.some((u) => fmt(u) === 'image/png' && u.searchParams.get('TRANSPARENT') === 'TRUE'), JSON.stringify(li));
  check('warstwa zapamiętała zapasowy format', li.useAlt === true);
  check('panel o tym informuje', /format PNG \(serwer nie obsłużył JPEG\)/.test(await page.textContent('#reliefStatus')), await page.textContent('#reliefStatus'));
  n = log.wms.length;
  await page.evaluate(() => LidarPL.map.setView(52.4064, 16.9252, 12)); await settle(2500);
  rq = log.wms.slice(n).filter(relief);
  check('kolejne kafle idą od razu w PNG (bez zbędnych prób JPEG)', rq.length > 0 && rq.every((u) => fmt(u) === 'image/png'), rq.map(fmt).join(','));
  mode.noJpeg = false;

  // --- ręczny przełącznik PNG
  await page.goto('about:blank');
  await page.goto(PAGE + '#13.00/50.06470/19.94500'); await settle(1200);
  n = log.wms.length;
  await page.check('#pngChk'); await settle(1500);
  rq = log.wms.slice(n).filter(fine);
  check('przełącznik PNG: kafle w PNG z przezroczystością', rq.length > 0 && rq.every((u) => fmt(u) === 'image/png' && u.searchParams.get('TRANSPARENT') === 'TRUE'), rq.map(fmt).join(','));
  await page.reload(); await settle(800);
  check('wybór PNG przetrwał odświeżenie', await page.isChecked('#pngChk'));
  await page.uncheck('#pngChk'); await settle(800);
  rq = log.wms.slice(-6).filter(fine);
  check('po odznaczeniu wraca JPEG', rq.length > 0 && rq.every((u) => fmt(u) === 'image/jpeg'), rq.map(fmt).join(','));
}

check('brak błędów JS w konsoli', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(`\n${passed} ok, ${failed} niepowodzeń`);
process.exit(failed ? 1 : 0);
