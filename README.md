# LIDAR Polska

Przeglądarkowa mapa reliefu terenu dla Polski na danych z lotniczego skanowania laserowego (GUGiK),
inspirowana serwisem daevorn-maps.org. Jeden plik `index.html`, bez zależności, bez budowania i bez konta.

## Uruchomienie

- Wystarczy otworzyć `index.html` w przeglądarce, albo
- wystawić folder jako stronę statyczną (np. `npx serve .`, GitHub Pages).

Podkład OpenStreetMap może nie ładować się po otwarciu z `file://` (OSM wymaga nagłówka Referer) –
pozostałe warstwy działają, a po wystawieniu przez http(s) działa też OSM.

## Co potrafi

- Podkłady: satelita Esri, ortofotomapa GUGiK, OpenStreetMap. Zdjęcia Esri nie mają podpisów, więc nazwy miejscowości i granice to osobna warstwa (pole „Nazwy miejscowości i granice”).
- Lista **„Przejdź do miasta”** (największe miasta, Zakopane, Biskupin). Start: Kraków.
- Relief LIDAR z usług WMS GUGiK: cieniowanie terenu (hillshade) i widoczność nieba (SkyView / SVF).
  Domyślnie relief jest rysowany od poziomu przybliżenia 10 (`RELIEF_MIN_ZOOM`), bo w skali kraju cieniowanie nizin jest jednolicie szare i tylko zasłania podkład.
  Próg zmienisz w panelu („Pokaż relief od poziomu”), a gdy relief jest ukryty z powodu oddalenia, na mapie pojawia się wskazówka z przyciskiem „Przybliż”.
- Kafle, które zawiodą chwilowo, są ponawiane (po 0,5 s i 1,2 s); status w panelu dotyczy kafli widocznych w bieżącym widoku.
- Domyślnie relief jest mieszany przez **mnożenie** (zachowuje kolory podkładu); suwak przezroczystości (0–100%) reguluje siłę.
- Tryb **Porównanie** z przeciąganą linią podziału (relief po prawej, podkład po lewej).
- **Szybkość ładowania:** kafle WMS są pobierane po 512 px (4× mniej zapytań niż po 256 px), od środka widoku na zewnątrz;
  podczas zoomu kółkiem lub gestem nie są pobierane kafle pośrednich poziomów (czekamy ok. 0,15 s na koniec gestu);
  relief nie jest pobierany w większej szczegółowości niż poziom 18 (siatka NMT ma 1 m). Stałe `WMS_TILE_PX`, `ZOOM_SETTLE_MS`,
  `SLOW_TILE_MS` są na górze skryptu. Panel pokazuje średni czas kafla reliefu i ostrzega, gdy serwer odpowiada wolno
  (> 2,5 s), więc od razu widać, czy zwalnia GUGiK, czy coś innego.
- **Pasek ładowania** u góry ekranu z procentami (wszystkie warstwy razem). Pojawia się, gdy ładowanie trwa dłużej niż ułamek sekundy, i znika po wczytaniu całej mapy.
- Własne punkty: dodawanie, nazwy, usuwanie, import i eksport **GPX / KML**, zapis w `localStorage` przeglądarki.
- Współrzędne WGS84 i PL-1992 oraz wysokość terenu pod kursorem.
- Link do widoku w adresie (`#zoom/lat/lon`), obsługa myszy, dotyku (pinch) i klawiatury (strzałki, `+`/`-`).
- **Własne źródło WMS** (panel → „Własne źródło WMS”): dowolna warstwa EPSG:3857, z przyciskiem pobierającym listę warstw z `GetCapabilities`.

## Konfiguracja źródeł

Adresy usług i nazwy warstw są na górze skryptu w `index.html` (`BASE_LAYERS`, `RELIEF_LAYERS`, `ELEVATION_URL`).
Jeśli GUGiK zmieni usługę albo nazwę warstwy, popraw je tam. Panel pokazuje status ładowania podkładu
(„Podkład nie wczytał żadnych kafli”) i reliefu („Serwer nie zwrócił kafli”), więc błędny adres, nazwa warstwy
albo zablokowane połączenie są od razu widoczne.

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
