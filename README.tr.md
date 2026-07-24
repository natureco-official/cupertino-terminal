# Cupertino Terminal

> 🇬🇧 [English](README.md)

**Electron olmayan, macOS kalitesinde terminal.** Gerçek bir yerel uygulama — her işletim sisteminin kendi WebView'ını süren bir Rust çekirdeği — böylece sıradan terminallerin yaklaşamayacağı bir hafiflikte, Cupertino tarzı güzel bir arayüz elde edersiniz. Windows, macOS ve Linux. Tauri, Rust ve xterm.js ile geliştirildi.

![Cupertino Terminal](docs/screenshot.png)

## Neden bilgisayarınızda olmalı?

"Modern" terminallerin çoğu, sadece bir istem çizmek için koca bir Chromium tarayıcısı ve bir Node çalışma zamanı taşır — daha tek bir tuşa basmadan yüzlerce megabayt RAM. Cupertino Terminal bunu yapmaz. **Gömülü Chromium yok, Node yok, Electron yok.** Yalnızca hızlı açılan, hafızayı azıcık kullanan ve Mac gibi hissettiren yerel bir binary.

- 🪶 **Electron terminalden ~10 kat daha hafif** — tek bir yerel binary, **~29 MB boşta RAM**, **56 KB** başlangıç arayüz yükü.
- ⚡ **Kare-altı tuş gecikmesi (~6 ms p95)** — geri-basınçlı, ham bayt akışlı gerçek bir PTY üzerinde; gecikme yok, `yes` seli altında bile düşen çıktı yok.
- 🍎 **Gerçek macOS hissi** — yerel trafik ışıkları, vibrancy, pencere sürükleme, boşta içi-boş imleç ve readline/SIGINT'e gerçekten saygı gösteren "Cmd uygulamaya / Ctrl kabuğa" tuş yönetimi.
- 🔐 **ZeroLink: kendi şifreli uzak terminaliniz** — dahili, SSH benzeri, eşler arası, uçtan uca şifreli kabuk paylaşımı. Sunucu yok, hesap yok, açık port yok.
- 🖥️ **Her işletim sisteminde tek deneyim** — Windows'ta ne kadar kusursuzsa Mac'te de o kadar kusursuz. Aynı kısayollar, aynı incelik.
- 🔄 **İmzalı otomatik güncelleme** — uygulama kendini GitHub Releases'ten güncel tutar.

Gününüzü terminalde geçiriyorsanız, gün boyu açık tutmak isteyeceğiniz terminal budur.

## Tek komutla kurulum

Tek satır, her makine — işletim sistemini ve işlemcini algılar, doğru imzalı kurucuyu indirir ve çalışır hale getirir. Bu repoyu bir AI ajanına verip "bunu kur" demen de aynı sonucu verir (bkz. [AGENTS.md](AGENTS.md)).

**macOS / Linux**

```sh
curl -fsSL https://raw.githubusercontent.com/natureco-official/cupertino-terminal/main/install.sh | sh
```

**Windows (PowerShell)**

```powershell
irm https://raw.githubusercontent.com/natureco-official/cupertino-terminal/main/install.ps1 | iex
```

Yönetici yetkisi yok, derleme aracı yok, `jq` yok — sadece `curl`/PowerShell. macOS'ta Gatekeeper karantina bayrağını da senin için temizler ve uygulamayı başlatır.

## İndirme

Elle kurmayı mı tercih edersin? Güncel kurulum dosyasını **[GitHub Releases](https://github.com/natureco-official/cupertino-terminal/releases/latest)** sayfasından indir — kurulum bir dakikadan kısa.

| Platform | Paket |
|---|---|
| Windows 10/11 x64 | `x64-setup.exe` |
| Apple Silicon Mac | `aarch64.dmg` |
| Intel Mac | `x64.dmg` |
| Linux x64 | `amd64.AppImage` |

macOS paketleri ad-hoc imzalıdır (noterleştirme yol haritasında). İlk açılışta Gatekeeper engellerse **Sistem Ayarları → Gizlilik ve Güvenlik → Yine de Aç** deyin. Windows paketlerinde tek seferlik SmartScreen uyarısı çıkarsa **Ek bilgi → Yine de çalıştır** seçin.

## Öne çıkan özellikler

- PowerShell, Komut İstemi, WSL, zsh, bash ve fish otomatik algılamalı gerçek PTY oturumları
- On klasik terminal renk profili, ayarlanabilir opaklık ve cam efektleri
- Sekmeler ile kalıcı dikey/yatay bölünmüş paneller ve sürüklenebilir ayırıcılar
- Sekme, panel düzeni, çalışma dizini ve pencere durumunu geri yükleme
- Terminal çıktısında arama (`Ctrl/⌘+F`) ve bulanık aramalı Komut Paleti (`Ctrl/⌘+Shift+P`)
- Çıkış kodu, süre ve çalışma dizini bilgili akıllı komut geçmişi
- Doğru çalışma dizini ve komut durumu için kabuk entegrasyonu (OSC 7 / OSC 133)
- Gömülü JetBrains Mono, Türkçe/İngilizce arayüz, Gezgin/Finder açma entegrasyonu

## ZeroLink — dahili şifreli uzak terminal

`Ctrl/⌘+L` ile özel bir kabuk paylaşın veya tek kullanımlık kodla bağlanın. ZeroLink iki makine arasında **uçtan uca şifreli, eşler arası** bir uzak kabuk açar — etkileşimli oturum, terminal boyutlandırma, dosya aktarımı ve yerel port yönlendirme — merkezi sunucu ve hesap olmadan.

Kaputun altında: geçici **ECDH P-256**, açık anahtar sabitlemeli handshake ve **eşleştirme-anahtarı HMAC** karşılıklı kimlik doğrulaması (kodu olmayan taraf bağlanamaz — gerçek bir saldırgana karşı doğrulandı), **HKDF-SHA256** ve sıkı tekrar/sıra korumalı **AES-256-GCM**. Kodlar tek kullanımlıktır ve beş dakikada geçersiz olur. Ağlar arası bağlantı NAT koşullarına bağlıdır; bir relay yapılandırılabilir ve terminal içeriği relay üzerinden geçse bile şifreli kalır.

## Performans

Aynı makinede Windows Terminal ile karşılaştırıldığında:

| Ölçüt | Cupertino Terminal |
|---|---|
| Boşta hafıza (RSS) | ~29 MB |
| Tuştan-piksele gecikme (p95) | ~6 ms |
| Başlangıç arayüz yükü | 56 KB (543 KB'den düştü) |
| Gömülü tarayıcı/Node çalışma zamanı | yok |

## Klavye kısayolları

macOS üzerinde `Ctrl` yerine `⌘` kullanılır.

| Kısayol | İşlev |
|---|---|
| `Ctrl/⌘+T` | Yeni sekme |
| `Ctrl/⌘+W` | Etkin paneli veya sekmeyi kapat |
| `Ctrl/⌘+1…9` | Sekmeler arasında geçiş |
| `Ctrl/⌘+F` | Terminal çıktısında ara |
| `Ctrl/⌘+Shift+P` | Komut Paleti ve akıllı geçmiş |
| `Ctrl/⌘+Shift+\` | Sağa böl |
| `Ctrl/⌘+Shift+-` | Aşağı böl |
| `Ctrl/⌘+Alt+Sağ` | Diğer panele odaklan |
| `Ctrl/⌘+,` | Ayarlar |
| `Ctrl/⌘+L` | ZeroLink paneli |
| `Ctrl/⌘+C` | Seçimi kopyala; seçim yoksa kesme sinyali gönder |
| `Ctrl/⌘+V` | Yapıştır |

## Kaynaktan çalıştırma

Gereksinimler: Node.js 22+, Git, Rust araç zinciri ve işletim sisteminiz için [Tauri v2 önkoşulları](https://v2.tauri.app/start/prerequisites/) (Windows'ta WebView2, macOS'ta Xcode komut satırı araçları, Linux'ta WebKitGTK).

```powershell
git clone https://github.com/natureco-official/cupertino-terminal.git
cd cupertino-terminal
npm install
npm start          # tauri dev — canlı yeniden yükleme ile yerel pencere
```

Kalite kontrolleri:

```powershell
npm run check            # sözdizimi + birim testleri
npm run typecheck        # tsc --noEmit
npm run smoke:tauri      # uygulama smoke testi
npm run perf:tauri       # PTY/gecikme ölçümü
npm audit --audit-level=high
```

Geçerli platform için kurulum paketi oluşturma:

```powershell
npm run tauri:build
```

## Kabuk entegrasyonu

Cupertino Terminal desteklenen zsh, bash, fish ve PowerShell oturumlarına entegrasyonunu otomatik ekler. Çalışma dosyaları salt-okunur uygulama paketine değil, yazılabilir uygulama-verisi dizinine konur — kullanıcının kabuk yapılandırması değiştirilmeden çalışma dizini, istem sınırları, komut süresi ve çıkış kodu güvenilir biçimde izlenir. Windows'ta WSL dağıtımları otomatik algılanır ve varsa tercih edilir; yoksa PowerShell kullanılır.

## Yayın süreci

`main` dalına yapılan her gönderim ve pull request; gerçek CI üzerinde JavaScript, yerel PTY, uygulama smoke, performans ve güvenlik testlerinden geçer — Windows MSVC ve Apple Silicon üzerinde `cargo check` ve `cargo test` dahil. Bir `v*` etiketi ayrıca Windows x64, Apple Silicon macOS, Intel macOS ve Linux paketlerini oluşturur, güncelleyici artefaktlarını imzalar ve otomatik güncelleme manifestiyle birlikte GitHub Release'e ekler.

## Lisans

MIT — ayrıntılar için [LICENSE](LICENSE). JetBrains Mono, [SIL Open Font License 1.1](src/fonts/OFL.txt) kapsamında sunulur.

Cupertino Terminal bağımsız bir yazılımdır; Apple Inc. ile bağlantılı değildir ve Apple tarafından onaylanmamıştır. macOS ve Terminal.app, Apple Inc. şirketinin ticari markalarıdır.

[NatureCo](https://natureco.me) ekosisteminin bir parçasıdır.
