# Rešeno Evidenca – spletna različica (iPhone brez App Stora)

Brezplačna različica aplikacije za evidenco delovnega časa, ki jo zaposleni na iPhonu dodajo na
začetni zaslon in uporabljajo kot običajno aplikacijo. Deluje tudi na telefonih Android in na
računalniku (Chrome, Edge, Safari, Firefox).

- **Enake funkcije kot aplikacija za Android:** prihod, malica, odhod, opis dneva/lokacija, opombe,
  lastno vozilo, mesečni pregled, PDF in CSV poročilo, pošiljanje ur vodji, zavihek Ekipa za vodjo.
- **Ista Google Preglednica in iste povezave** (B8 za zaposlene, B9 za vodjo) kot pri Androidu.
- **Jutranji opomnik in opomnik za odhod** prideta kot obvestilo na iPhone (iOS 16.4 ali novejši).
  Pošilja ju skripta v Google Preglednici, zato morata biti aplikacija povezana z vodjo in skripta
  posodobljena (poglavje 3).
- **Brez stroškov:** gostovanje na GitHub Pages, skripta v Google Preglednici in obvestila Apple so
  brezplačni. Apple Developer račun ni potreben.

---

## 1. Kaj potrebuješ

| Kaj | Kdo | Koliko časa |
|---|---|---|
| Brezplačen račun na [github.com](https://github.com) za objavo aplikacije (poglavje 2) | vodja, enkrat | 10 min |
| Posodobitev skripte v obstoječi Google Preglednici (poglavje 3) | vodja, enkrat | 3 min |
| Namestitev na iPhone (poglavje 4) | vsak zaposleni | 2 min |

Za objavo in posodobitev skripte uporabi računalnik.

## 2. Objava aplikacije na GitHub Pages

1. Na [github.com](https://github.com) ustvari brezplačen račun (Sign up). Ime računa bo del naslova
   aplikacije, npr. račun `reseno` → `https://reseno.github.io/…`.
2. Zgoraj desno **+ → New repository**. Ime npr. `evidenca`, izberi **Public** in klikni
   **Create repository**.
   Brezplačni GitHub Pages deluje samo za javne repozitorije. To ni težava: v datotekah je samo
   aplikacija – brez podatkov, imen in brez povezave do preglednice (povezavo vsak zaposleni prilepi
   v aplikacijo na svojem telefonu).
3. Na strani novega repozitorija klikni **uploading an existing file** (ali **Add file → Upload files**).
   Razširi `Reseno-Evidenca-splet.zip`, odpri razširjeno mapo, označi **vse datoteke** (Ctrl+A) in jih
   povleci v okno (ali jih izberi s *choose your files*). Aplikacija nima podmap, zato morajo biti vse
   datoteke na prvi ravni repozitorija. Spodaj klikni **Commit changes**.
4. **Settings → Pages** (levo). Pri *Build and deployment* izberi *Source:* **Deploy from a branch**,
   *Branch:* **main** in **/ (root)** → **Save**.
5. Naslov aplikacije je `https://<ime-računa>.github.io/<ime-repozitorija>/`, npr. za račun `reseno-e`
   in repozitorij `evidenca`: `https://reseno-e.github.io/evidenca/`. Objava traja 1–2 minuti; potek
   vidiš v zavihku **Actions** (»pages build and deployment« z zeleno kljukico). Ko je objavljeno, se
   po osvežitvi strani **Settings → Pages** zgoraj prikaže tudi okvir *Your site is live at …*.
   Naslov odpri na računalniku – prikazati se mora pozdravni zaslon aplikacije (ne samo »Nalagam …«).
6. Ta naslov pošlji zaposlenim (skupaj s povezavo za zaposlene iz celice B8). Naslov aplikacije ni
   skriven; skrivna je samo povezava s kodo.

Namesto GitHub Pages lahko uporabiš katerokoli gostovanje statičnih strani s **https**
(npr. Netlify ali Cloudflare Pages) – naložiš iste datoteke.

## 3. Posodobitev skripte v Google Preglednici (za opomnike)

Nova skripta doda pošiljanje opomnikov za spletno različico. Aplikacije za Android in iPhone delujejo
z njo enako kot prej, povezave ostanejo enake.

1. Odpri preglednico → **Razširitve → Apps Script**.
2. Izbriši vso kodo, prilepi celotno vsebino nove datoteke **`Koda.gs`** in shrani (ikona diskete).
3. Zgoraj izberi funkcijo **namesti** in klikni **Zaženi** (Run). Google znova vpraša za dovoljenje,
   ker skripta potrebuje dve novi dovoljenji: *povezava z zunanjo storitvijo* (pošiljanje obvestil)
   in *izvajanje, ko vas ni* (samodejni zagon vsakih 5 minut). Izberi svoj račun →
   **Napredno (Advanced) → Pojdi na … (nevarno)** → **Dovoli**.
4. **Deploy → Manage deployments** (Uvedi → Upravljaj uvedbe) → ikona svinčnika ✎ →
   *Version:* **New version** → **Deploy**.

**Vrstni red je pomemben:** najprej zaženi *namesti* in dovoli dostop, šele nato objavi novo različico.
Če nova različica potrebuje dovoljenje, ki ga še nisi dal, spletna aplikacija skripte vrne napako in
pošiljanje ur se ustavi za vse zaposlene, dokler ne zaženeš *namesti*.

Preverjanje: v preglednici je nov list **Naprave** (tu se prikažejo telefoni s spletno različico,
ura opomnika in zadnje poslano obvestilo), v Apps Script pod **Sprožilci** (ikona ure) pa
`posljiOpomnike` z zagonom vsakih 5 minut. Če se ob zagonu *namesti* prikaže opozorilo o starem
izvajalnem okolju, v **Project Settings** vklopi **Enable Chrome V8 runtime** in znova zaženi *namesti*.

## 4. Namestitev na iPhone (vsak zaposleni)

1. Naslov aplikacije odpri v **Safariju**. Če ga odpreš iz Viberja, WhatsAppa ali e-pošte, se lahko
   odpre v njihovem brskalniku – tapni **⋯ → Odpri v Safariju**.
2. Tapni **Deli** (kvadrat s puščico) → **Dodaj na začetni zaslon** → **Dodaj**.
   Aplikacija sama prikaže ta navodila, če jo odpreš v Safariju.
3. Aplikacijo **Evidenca** odpri z začetnega zaslona.
4. Vpiši ime in priimek, prilepi **povezavo od vodje** (B8) in tapni **Začni**.
5. Tapni **Vklopi opomnike** in dovoli obvestila.
6. V **Nastavitvah** tapni **Preizkusi obvestilo** – obvestilo mora priti v nekaj sekundah.

Ure vnašaj samo v aplikaciji na začetnem zaslonu: Safari in aplikacija na začetnem zaslonu imata na
iPhonu ločena shranjevanja.

**Android:** zaposleni lahko še naprej uporabljajo aplikacijo APK ali odprejo spletni naslov v Chromu
in izberejo **⋮ → Namesti aplikacijo**. **Računalnik:** vodja lahko spletni naslov odpre v Chromu ali
Edgu in s povezavo za vodjo (B9) vidi zavihek **Ekipa** tudi na računalniku. Vsak zaposleni naj
uporablja eno aplikacijo – vsaka namestitev se v preglednici prikaže kot ločena oseba.

## 5. Razlike glede na aplikacijo za Android

| | Android (APK) | Spletna različica |
|---|---|---|
| Opomniki | iz telefona, tudi brez interneta | iz preglednice vodje (potrebna sta povezava z vodjo in internet) |
| Točnost opomnika | ob nastavljeni uri | v 0–5 minutah po nastavljeni uri |
| Gumb »Zabeleži prihod« v obvestilu | da | na Androidu da, na iPhonu ne (tap odpre aplikacijo) |
| Pripomoček na začetnem zaslonu | da | ne |
| Naslov trenutne lokacije | Android/Google | OpenStreetMap |
| Delovanje brez interneta | da | da (aplikacija se naloži iz pomnilnika telefona) |

Jutranjega opomnika ni, če je prihod za ta dan že v preglednici ali je dan označen kot dopust,
bolniška ali prosto. Opomnik za odhod pride, če je prihod zabeležen, odhod pa še ne.

## 6. Posodobitev spletne aplikacije

1. V repozitoriju na GitHubu naloži spremenjene datoteke (**Add file → Upload files**; obstoječe se
   zamenjajo).
2. V datoteki `sw.js` povečaj številko `VERSION` (npr. `1.0.2`), sicer telefoni nove različice ne
   prenesejo.
3. Ob naslednjem odprtju aplikacije se na vrhu prikaže **Na voljo je nova različica → Osveži**.
   Podatki na telefonih ostanejo.

## 7. Pogoste težave

- **Aplikacija ostane na »Nalagam …«** – v repozitoriju manjka katera od datotek (npr. `preact.js`) ali
  je v podmapi. Na zavihku **Code** morajo biti vse datoteke na prvi ravni.
- **»Preglednica vodje še ne pošilja opomnikov«** – skripta ni posodobljena (poglavje 3).
- **Obvestila ne pridejo** – preveri: iOS 16.4 ali novejši; aplikacija je odprta z začetnega zaslona;
  *Nastavitve → Obvestila → Evidenca → Dovoli obvestila*; način Fokus/Ne moti; v aplikaciji
  *Preizkusi obvestilo*. Na listu **Naprave** je v stolpcu *Stanje* rezultat zadnjega pošiljanja.
- **Opomnik pride nekaj minut pozneje** – skripta preverja opomnike vsakih 5 minut; v načinu
  varčevanja z energijo jih iPhone lahko še nekoliko zamakne.
- **»Strežnik ni dosegljiv«** – ni interneta ali povezava od vodje ni pravilna (glej tudi
  *Pogoste težave* v glavnem README).
- **Po posodobitvi skripte nihče ne pošilja ur** – v Apps Script zaženi *namesti*, dovoli dostop in
  znova objavi novo različico (poglavje 3).
- **Izbris aplikacije z začetnega zaslona izbriše podatke na telefonu.** Kopija je v preglednici,
  če je aplikacija povezana z vodjo. Pred menjavo telefona uporabi *Nastavitve → Izvozi vse podatke*.

## 8. Za razvijalce

```
splet/                     vse datoteke, ki se objavijo (GitHub Pages) – brez podmap
  index.html, app.css      stran in videz (barve logotipa)
  app.js                   zasloni (Preact + htm), shramba, pošiljanje vodji, opomniki, lokacija, poročila
  core.js                  logika, enaka kot v Kotlinu: izračun ur, prazniki, povzetki, CSV, besedila, postavitev PDF
  pdf.js                   zapisovalnik PDF (vdelan podnabor pisave Roboto, logotip JPEG)
  db.js                    IndexedDB (uporabljata ga stran in service worker)
  sw.js                    delovanje brez interneta, prikaz obvestil, posodobitve (VERSION)
  preact.js                Preact 10.27.2 in htm 3.1.1 (licenci LICENSE-preact.txt, LICENSE-htm.txt)
  manifest.webmanifest, ikone (*.png), logotipi (logo-*.png, logo-pdf.jpg), pisava Roboto (*.ttf, Apache 2.0)
splet-test/                preizkusi (se ne objavijo)
  core.test.js, pdf.test.js   node --test splet-test/core.test.js splet-test/pdf.test.js
  e2e/run.js                  celovit preizkus v Chromiumu (Playwright) s pravo skripto Koda.gs
streznik/Koda.gs           skripta (dodano: list Naprave, sprožilec posljiOpomnike, podpis VAPID ES256)
```

- `core.js` je prevod Kotlinove logike; ujemanje je preverjeno z naključnimi primerjavami
  (400 mesecev, 218.000 risalnih ukazov PDF, CSV, povzetki, prazniki 1990–2100, urniki opomnikov).
- Obvestila so spletna potisna sporočila (RFC 8030) **brez vsebine**: skripta podpiše žeton VAPID
  (ECDSA P-256, RFC 6979) in pošlje prazno sporočilo; service worker sestavi besedilo iz podatkov na
  telefonu. Skripta zato ne potrebuje šifriranja vsebine.
- Pošiljanje ur: `POST` z vsebino `text/plain` (brez predhodne zahteve CORS); Google odgovor vrne prek
  preusmeritve, ki ji brskalnik sledi sam. Oblika podatkov je enaka kot pri Androidu in iPhonu.
