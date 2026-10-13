# LIDAR Polska

Przeglądarkowa mapa reliefu terenu dla Polski na danych z lotniczego skanowania laserowego (GUGiK),
inspirowana serwisem daevorn-maps.org. Jeden plik `index.html`, bez zależności, bez budowania i bez konta.

## Uruchomienie

- Wystarczy otworzyć `index.html` w przeglądarce, albo
- wystawić folder jako stronę statyczną (np. `npx serve .`, GitHub Pages).

Podkład OpenStreetMap może nie ładować się po otwarciu z `file://` (OSM wymaga nagłówka Referer) –
pozostałe warstwy działają, a po wystawieniu przez http(s) działa też OSM.

## Co potrafi

- Podkłady: satelita Esri, ortofotomapa GUGiK, OpenStreetMap.
- Relief LIDAR z usług WMS GUGiK: cieniowanie terenu (hillshade) i widoczność nieba (SkyView / SVF).
- Suwak przezroczystości (0–100%) albo tryb **Porównanie** z przeciąganą linią podziału (relief po prawej, podkład po lewej).
- Własne punkty: dodawanie, nazwy, usuwanie, import i eksport **GPX / KML**, zapis w `localStorage` przeglądarki.
- Współrzędne WGS84 i PL-1992 oraz wysokość terenu pod kursorem.
- Link do widoku w adresie (`#zoom/lat/lon`), obsługa myszy, dotyku (pinch) i klawiatury (strzałki, `+`/`-`).
- **Własne źródło WMS** (panel → „Własne źródło WMS”): dowolna warstwa EPSG:3857, z przyciskiem pobierającym listę warstw z `GetCapabilities`.

## Konfiguracja źródeł

Adresy usług i nazwy warstw są na górze skryptu w `index.html` (`BASE_LAYERS`, `RELIEF_LAYERS`, `ELEVATION_URL`).
Jeśli GUGiK zmieni usługę albo nazwę warstwy, popraw je tam. Panel pokazuje też status ładowania reliefu
(„Serwer nie zwrócił kafli”), więc błędny adres lub nazwa warstwy jest od razu widoczny.

## Testy

```
node test/e2e.mjs
```

Test uruchamia prawdziwy Chromium (wymaga globalnie zainstalowanego pakietu `playwright`). Serwery zewnętrzne są
podmieniane na wygenerowane kafle, więc sprawdzane są dokładnie te adresy WMS i BBOX, które wysyła aplikacja.
Test **nie** sprawdza działania prawdziwych usług GUGiK.

## Dane

Dane wysokościowe i ortofotomapa: GUGiK / Geoportal.gov.pl (dane otwarte). Obrazy satelitarne: Esri, Maxar, Earthstar
Geographics. Mapa: autorzy OpenStreetMap. Zachowaj te atrybucje, jeśli publikujesz mapę.
