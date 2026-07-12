# Cupertino Terminal

> 🇬🇧 Read in English: [README.md](README.md)

**macOS Terminal.app**'in görünümünü ve hissini Windows'a taşıyan açık kaynak bir terminal uygulaması — traffic-light düğmeler, sekmeler, macOS Terminal'in 10 klasik renk profili, buğulu cam efektiyle ayarlanabilir pencere saydamlığı ve birinci sınıf **WSL (Ubuntu + zsh)** desteği.

Electron + xterm.js + node-pty ile geliştirildi. Kurulumda derleme gerekmez: PTY katmanı hazır (prebuilt) ikili dosyalar kullanır, yani **Python veya Visual Studio Build Tools gerekmez**.

![Cupertino Terminal — WSL'de zsh, Pro profiliyle](docs/screenshot.png)

## Özellikler

- 🚦 macOS tarzı pencere: traffic-light düğmeler, ortalanmış `süreç — sütun×satır` başlığı, ayrı sekme çubuğu (2+ sekmede görünür)
- 🎨 macOS Terminal'in 10 klasik profili: Pro, Basic, Homebrew, Man Page, Novel, Ocean, Grass, Red Sands, Silver Aerogel, Solid Colors
- 🪟 Ayarlanabilir opaklık (%0–100) ve iki cam kipi: **Buğulu** (Windows 11 acrylic) ve **Berrak** (net görünüm)
- ⚙️ Ayarlar paneli (`Ctrl+,`): profil galerisi, yazı boyutu, imleç stili/yanıp sönme, varsayılan kabuk, arayüz dili (Türkçe / İngilizce)
- 🐧 WSL otomatik algılama: dağıtım kuruluysa yeni sekmeler doğrudan Linux'ta açılır; yoksa PowerShell
- 📁 İstenen klasörde açılma: komut satırı argümanı olarak dizin verilebilir (isteğe bağlı Gezgin sağ-tık menüsü bunu kullanır)
- ⌨️ macOS'a sadık kısayollar: `Ctrl+T` yeni sekme, `Ctrl+W` sekmeyi kapat, `Ctrl+1..9` sekme geçişi, `Ctrl+C` seçim varsa kopyala, sağ tık kopyala/yapıştır
- 🔤 Gömülü JetBrains Mono fontu — her makinede aynı görünüm
- 🔗 **ZeroLink** — sunucusuz, uçtan uca şifreli P2P uzak terminal (SSH benzeri): tek kullanımlık kodla başka bir makineye özel kabuk paylaşın (aşağıya bakın)

## Gereksinimler

| | |
|---|---|
| İşletim sistemi | Windows 10 veya 11 (64-bit). **Buğulu** cam efekti Windows 11 22H2+ ister; eski sürümlerde uygulama opak zemine düşer ve seçenek devre dışı görünür. |
| Node.js | 18+ (yalnızca kaynaktan çalıştırmak / paket üretmek için) |
| WSL | İsteğe bağlı — aşağıdaki ayrıntılı kurulum rehberine bakın |

## Hızlı başlangıç (kaynaktan çalıştırma)

```powershell
git clone https://github.com/<kullanici-adiniz>/cupertino-terminal.git
cd cupertino-terminal
npm install
npm start
```

Windows kurulum paketi üretmek (NSIS, çıktı `dist/` içinde):

```powershell
npm run dist
```

> **SmartScreen notu:** imzasız açık kaynak derlemeler ilk çalıştırmada Windows SmartScreen uyarısı verir. *Daha fazla bilgi → Yine de çalıştır* deyin.

## Ayrıntılı WSL kurulum rehberi (eksiksiz macOS hissi)

Uygulama kutudan çıktığı haliyle PowerShell ile çalışır; ama gerçek macOS deneyimi gerçek bir Unix kabuğundan gelir. Windows 10/11'de **Ubuntu + zsh + Oh My Zsh**'i amaçlandığı gibi kurmak için şu adımları izleyin. Tüm komutlar kopyala-yapıştıra hazırdır.

### Adım 1 — Windows özelliklerini etkinleştirin

**PowerShell'i Yönetici olarak** açın ve çalıştırın:

```powershell
dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
```

Windows isterse bilgisayarı yeniden başlatın.

### Adım 2 — Ubuntu'yu kurun

Yine PowerShell'de:

```powershell
wsl --install -d Ubuntu
```

Kurulum bitince Ubuntu açılır ve bir **Unix kullanıcı adı ile parola** oluşturmanızı ister. İstediğinizi seçebilirsiniz — Windows hesabınızdan bağımsızdır. (Parola `sudo` komutlarında tekrar sorulur, aklınızda tutun.)

Doğrulayın:

```powershell
wsl --status
wsl -l -v
```

`Ubuntu`'yu `VERSION 2` olarak görmelisiniz.

> **Uygulama için bu kadarı yeterli:** Cupertino Terminal'i kapatıp açın; yeni sekmeler otomatik olarak Ubuntu'da açılır. Aşağıdaki adımlar macOS kabuk cilasını ekler.

### Adım 3 — zsh kurun (macOS'un kullandığı kabuk)

Cupertino Terminal'de bir sekme açın (veya PowerShell'de `wsl` yazın) ve çalıştırın:

```bash
sudo apt update && sudo apt install -y zsh
chsh -s $(which zsh)
```

`chsh`, zsh'ı varsayılan kabuğunuz yapar — yeni oturumlarda geçerli olur.

### Adım 4 — Oh My Zsh + eklentiler (önerilir)

```bash
sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
```

Ardından en sevilen iki eklentiyi ekleyin (geçmişe dayalı otomatik öneri ve canlı sözdizimi renklendirme):

```bash
git clone --depth 1 https://github.com/zsh-users/zsh-autosuggestions ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-autosuggestions
git clone --depth 1 https://github.com/zsh-users/zsh-syntax-highlighting ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-syntax-highlighting
```

### Adım 5 — `~/.zshrc` yapılandırması

Yapılandırmayı `nano ~/.zshrc` ile açıp şu değişiklikleri yapın (ya da dosyayı aşağıdaki blokla değiştirin):

```zsh
export ZSH="$HOME/.oh-my-zsh"

# Klasik Oh My Zsh görünümü (ok istemi + git dalı).
# Sade macOS fabrika istemi isterseniz: ZSH_THEME="" yapın ve
# en alttaki PROMPT satırının yorumunu kaldırın.
ZSH_THEME="robbyrussell"

plugins=(git zsh-autosuggestions zsh-syntax-highlighting)

source $ZSH/oh-my-zsh.sh

# Pencere/sekme başlığı: "kullanıcı@makine: ~/dizin" — uygulamanın sekme başlıkları bundan beslenir
ZSH_THEME_TERM_TITLE_IDLE='%n@%m: %~'
ZSH_THEME_TERM_TAB_TITLE_IDLE='%n@%m: %~'
DISABLE_AUTO_TITLE="false"

# Oturumlar arası ortak komut geçmişi
setopt SHARE_HISTORY HIST_IGNORE_DUPS HIST_IGNORE_SPACE

# macOS fabrika istemi (ZSH_THEME="" ile birlikte açın):
# PROMPT='%n@%m %1~ %# '
```

Uygulayın:

```bash
exec zsh
```

### Adım 6 — (İsteğe bağlı) WSL içine geliştirici araçları

```bash
sudo apt install -y nodejs npm python3-pip python3-venv unzip zip
```

Windows birlikte çalışabilirliği hazır gelir: WSL'den Windows programlarını sonuna `.exe` ekleyerek çağırabilirsiniz — örn. `explorer.exe .` bulunduğunuz klasörü Dosya Gezgini'nde açar.

### Sorun giderme

| Belirti | Çözüm |
|---|---|
| Ubuntu kurduktan sonra uygulama hâlâ PowerShell açıyor | Uygulamayı tamamen kapatıp açın — WSL varlığı açılışta bir kez algılanır. |
| `wsl --install` yeniden başlatma istiyor | Yeniden başlatın, komutu tekrar çalıştırın. |
| Sekme başlığı yalnızca `~` gösteriyor | Adım 5'teki `ZSH_THEME_TERM_TITLE_IDLE` ve `ZSH_THEME_TERM_TAB_TITLE_IDLE` satırlarının ikisinin de ekli olduğundan emin olun. |
| Buğulu cam seçeneği soluk/devre dışı | Windows sürümünüz 11 22H2'den eski — Berrak kipi kullanın. |

## Gezgin sağ-tık menüsüne "Cupertino Terminal'de Aç"

Windows kurucusu bu girdiyi klasörler ve klasör arka planları için otomatik ekler; kaldırma sırasında da temizler. Aşağıdaki komutlar yalnızca kurulum yapmadan kaynak koddan çalıştırırken gerekir.

PowerShell'de çalıştırın (yönetici gerekmez — yalnız geçerli kullanıcı). `C:\yol\cupertino-terminal` kısmını gerçek konumla değiştirin:

```powershell
$app  = 'C:\yol\cupertino-terminal'
$exe  = "$app\node_modules\electron\dist\electron.exe"
$cmd  = ('"{0}" "{1}" "%V"' -f $exe, $app)
foreach ($base in 'HKCU:\Software\Classes\Directory\shell\CupertinoTerminal',
                  'HKCU:\Software\Classes\Directory\Background\shell\CupertinoTerminal') {
  New-Item -Path "$base\command" -Force | Out-Null
  Set-ItemProperty -Path $base -Name '(Default)' -Value "Cupertino Terminal'de Aç"
  Set-ItemProperty -Path $base -Name 'Icon' -Value "$app\src\icon.ico"
  Set-ItemProperty -Path "$base\command" -Name '(Default)' -Value $cmd
}
```

Kaldırmak için: `HKCU:\Software\Classes\Directory` altındaki iki `CupertinoTerminal` anahtarını silin.

## ZeroLink — şifreli P2P uzak terminal

ZeroLink, bir terminal sekmesini doğrudan, uçtan uca şifreli bir eşler-arası (P2P)
tünel üzerinden **SSH benzeri uzak oturuma** dönüştürür. **Sunucu yoktur** — iki
makine doğrudan konuşur ve içeriği hiçbir üçüncü taraf göremez.

**Kabuk paylaş (host):** bir sekmeye `zl share` yazın (veya `Ctrl+L` → *Paylaş*).
Tek kullanımlık bir **ZeroLink kodu** alırsınız. Kodu karşı tarafa gönderin.

**Bağlan (client):** diğer makinede `zl connect <kod>` yazın (veya `Ctrl+L` →
*Bağlan*, kodu yapıştırın). Host'ta size özel, taze bir kabuk açılır — host kendi
ekranını paylaşmaz.

Bağlıyken paneli `Ctrl+L` ile açıp oturum araçlarını kullanın:

| Yetenek | Nasıl |
|---|---|
| İnteraktif kabuk | Her bağlantıya özel taze kabuk açılır |
| Boyut senkronu | Pencereyi büyütünce uzak kabuk da uyum sağlar (SIGWINCH) |
| Tek komut çalıştır | Tünel üzerinden `zl exec` benzeri tek komut |
| Dosya gönder | Panel → **Dosya Gönder** (host'un `~/ZeroLink-Downloads`'ına düşer) |
| Dosya al | Panel → **Al** `/uzak/yol` (sizin `~/ZeroLink-Downloads`'ınıza iner) |
| Port yönlendirme | Panel → yerel port → `host:port` (`ssh -L` gibi) |

**Güvenlik:** geçici ECDH P-256 → HKDF → AES-256-GCM; her mesajda kimlik-doğrulamalı
veri olarak bağlanan monotonik sayaç (replay koruması). Bağlantı kodu **tek
kullanımlık**, **5 dakika** sonra geçersiz ve HMAC imzalı. Sunucusuz tasarım içeriği
asla üçüncü bir tarafa yönlendirmez.

**Ağlar:** aynı yerel ağda doğrudan çalışır. Farklı ağlar arasında NAT'larınıza
bağlıdır — çoğu ev modemi STUN delme (hole-punching) ile çalışır. Simetrik/port-kısıtlı
NAT arkasında bir TURN relay gerekebilir: `settings.zlTurn`
(`{ url, username, credential }`) veya `ZEROLINK_TURN_URL` / `_USER` / `_CRED`
ortam değişkenlerini ayarlayın. Relay edilse bile içerik uçtan uca şifreli kalır.

## Klavye kısayolları

| Kısayol | İşlev |
|---|---|
| `Ctrl+T` | Yeni sekme (`+` düğmesine sağ tık: WSL / PowerShell / CMD seçimi) |
| `Ctrl+W` | Sekmeyi kapat |
| `Ctrl+1` … `Ctrl+9` | N. sekmeye geç |
| `Ctrl+C` | Metin seçiliyse kopyala, değilse SIGINT gönder |
| `Ctrl+V` | Yapıştır |
| `Ctrl+,` | Ayarlar |
| `Ctrl+L` | ZeroLink paneli (paylaş / bağlan / oturum araçları) |
| Sağ tık | Seçimi kopyala / yapıştır |

## Lisans

MIT — bkz. [LICENSE](LICENSE). [JetBrains Mono](https://www.jetbrains.com/lp/mono/) yazı tipini [SIL Open Font License 1.1](src/fonts/OFL.txt) ile içerir.

Cupertino Terminal bağımsız bir açık kaynak projesidir; Apple Inc. ile bir bağı yoktur ve Apple tarafından onaylanmamıştır. macOS ve Terminal.app, Apple Inc. şirketinin ticari markalarıdır.

---

<sub>**NatureCo** ekosisteminin parçası — [natureco.me](https://natureco.me) · Part of the NatureCo ecosystem</sub>
