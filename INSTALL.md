# Cupertino Terminal — Kurulum Kılavuzu

En güncel installer'lar her zaman burada:
**https://github.com/natureco-official/cupertino-terminal/releases/latest**

- **Windows** → `Cupertino.Terminal.Setup.<sürüm>.exe`
- **macOS** → mimarinize uygun `arm64.dmg` veya `x64.dmg`

Kurulumdan sonra uygulama şuralara yerleşir (masaüstünde **kalmaz**):
| Platform | Kurulum yeri | Kısayol |
|---|---|---|
| Windows | `C:\Program Files\Cupertino Terminal\` | Masaüstü + Başlat menüsü kısayolu (çift tıkla aç) |
| macOS | `/Applications/Cupertino Terminal.app` | Launchpad + Dock (tek tıkla aç) |

---

## 👤 İnsanlar için

### Windows
1. Releases sayfasından `Cupertino.Terminal.Setup.<sürüm>.exe` dosyasını indir.
2. Çift tıkla. SmartScreen uyarısı çıkarsa: **Ek bilgi → Yine de çalıştır**.
3. Kurulum sihirbazı açılır → yönetici izni ister (C: diskine kurmak için) → **Kur**.
4. Uygulama `C:\Program Files\Cupertino Terminal`'e kurulur; **masaüstünde bir kısayol** oluşur.
5. Masaüstündeki **Cupertino Terminal** simgesine çift tıkla — açılır. (İndirdiğin `.exe`'yi artık silebilirsin.)

### macOS
1. Releases sayfasından `Cupertino.Terminal-<sürüm>-arm64.dmg` dosyasını indir.
2. `.dmg`'ye çift tıkla → açılan pencerede **Cupertino Terminal** simgesini **Applications** klasörüne sürükle.
3. `.dmg`'yi çıkar (Finder'da yandaki ⏏ ile) ve indirilen `.dmg`'yi sil.
4. İlk açılışta imzasız uygulama uyarısı çıkar → **Applications**'ta simgeye **sağ tık → Aç → Aç**. (Bir kez; sonra normal çift tıkla açılır.)
   - Takılırsa Terminal'de: `xattr -cr "/Applications/Cupertino Terminal.app"`
5. Tek tıkla açmak için simgeyi **Dock**'a sürükle. (Masaüstünde takma ad istersen: Applications'tan simgeyi ⌘+⌥ basılı sürükle.)

---

## 🤖 Agent'lar için (otomatik kurulum)

Sürümden bağımsız; GitHub API'den son sürümün doğru dosyasını bulur, indirir, doğru yere kurar.

### Windows (PowerShell — yönetici gerekir)
```powershell
$repo  = 'Gencayolgun/cupertino-terminal'
$rel   = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest"
$asset = $rel.assets | Where-Object { $_.name -like '*.exe' } | Select-Object -First 1
$out   = Join-Path $env:TEMP $asset.name
Invoke-WebRequest $asset.browser_download_url -OutFile $out
# /S = sessiz kurulum; C:\Program Files'a kurar + masaüstü kısayolu oluşturur
Start-Process $out -ArgumentList '/S' -Verb RunAs -Wait
Remove-Item $out -Force
# Başlat: masaüstü kısayolu veya:
# & "C:\Program Files\Cupertino Terminal\Cupertino Terminal.exe"
```

### macOS (bash/zsh)
```bash
repo="natureco-official/cupertino-terminal"
url=$(curl -fsSL "https://api.github.com/repos/$repo/releases/latest" \
      | grep -o '"browser_download_url": *"[^"]*\.dmg"' | head -1 | cut -d'"' -f4)
tmp=$(mktemp -d); dmg="$tmp/cupertino.dmg"
curl -fL "$url" -o "$dmg"
mnt=$(hdiutil attach "$dmg" -nobrowse -noverify | grep -o '/Volumes/.*')
cp -R "$mnt/Cupertino Terminal.app" /Applications/
hdiutil detach "$mnt" -quiet
rm -rf "$tmp"
# İmzasız uygulamanın karantinasını kaldır (Gatekeeper'ı geç)
xattr -cr "/Applications/Cupertino Terminal.app"
# Başlat:
open -a "Cupertino Terminal"
```

---

## Güncelleme
Yeni sürüm çıkınca aynı adımları son installer ile tekrarla (üzerine kurar).
Agent script'leri zaten her zaman **en güncel** sürümü çeker.

## Notlar
- İmzasız derlemeler (kod imzalama sertifikası yok) → ilk açılışta işletim sistemi uyarır; yukarıdaki adımlar bunu geçer.
- macOS sürümleri Apple Silicon (`arm64`) ve Intel (`x64`) için ayrı üretilir.

---

<sub>**NatureCo** ekosisteminin parçası — [natureco.me](https://natureco.me) · Part of the NatureCo ecosystem</sub>
