# Cupertino Terminal

> 🇬🇧 [English](README.md)

Cupertino Terminal, geliştirici özelliklerinden ödün vermeden özenli bir macOS terminal deneyimi sunan, Windows ve macOS üzerinde çalışan açık kaynaklı bir terminal uygulamasıdır. Electron, xterm.js ve node-pty ile geliştirilmiştir.

![Cupertino Terminal](docs/screenshot.png)

## Öne çıkan özellikler

- PowerShell, Komut İstemi, WSL, zsh ve bash algılamalı gerçek PTY oturumları
- On klasik terminal renk profili, ayarlanabilir opaklık ve cam efektleri
- Sekmeler ile kalıcı dikey/yatay bölünmüş paneller ve sürüklenebilir ayırıcılar
- Sekme, panel düzeni, çalışma dizini ve pencere durumunu geri yükleme
- `Ctrl/⌘+F` ile terminal çıktısında arama
- `Ctrl/⌘+Shift+P` ile bulanık aramalı Komut Paleti
- Çıkış kodu, süre ve çalışma dizini bilgili akıllı komut geçmişi
- Doğru çalışma dizini ve komut durumu için kabuk entegrasyonu
- Gömülü JetBrains Mono ve Türkçe/İngilizce arayüz
- ZeroLink uçtan uca şifreli eşler arası uzak terminal
- Yerleşik güncelleme denetimi ve Gezgin/Finder açma entegrasyonu

## İndirme

Güncel Windows ve macOS kurulum dosyalarını [GitHub Releases](https://github.com/natureco-official/cupertino-terminal/releases/latest) sayfasından indirebilirsiniz.

| Platform | Paket |
|---|---|
| Windows 10/11 x64 | `.exe` kurucu |
| Apple Silicon Mac | `arm64.dmg` |
| Intel Mac | `x64 .dmg` |

İmzasız macOS paketleri Gatekeeper tarafından engellenebilir. Apple Developer imzalama ve noterleştirme tamamlanana kadar ilk açma denemesinden sonra **Sistem Ayarları → Gizlilik ve Güvenlik → Yine de Aç** seçeneğini kullanın. İmzasız Windows paketlerinde de SmartScreen uyarısı çıkabilir.

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

Gereksinimler: Node.js 22 veya üzeri ve Git.

```powershell
git clone https://github.com/natureco-official/cupertino-terminal.git
cd cupertino-terminal
npm install
npm start
```

Kalite kontrolleri:

```powershell
npm run check
npm run smoke:native
npm run smoke:app
npm run perf:pty
npm audit --audit-level=high
```

Kurulum paketi oluşturma:

```powershell
npm run dist
```

## Kabuk entegrasyonu

Cupertino Terminal desteklenen zsh, bash ve PowerShell oturumlarına entegrasyonunu otomatik olarak ekler. Böylece çalışma dizini, istem sınırları, komut süresi ve çıkış kodu güvenilir biçimde izlenir. Kullanıcının kabuk yapılandırma dosyaları değiştirilmez.

Windows üzerinde WSL dağıtımları otomatik algılanır. WSL varsa tercih edilir; yoksa PowerShell kullanılır.

## ZeroLink

ZeroLink iki eş arasında uçtan uca şifreli uzak kabuk oluşturur. `Ctrl/⌘+L` ile özel bir kabuk paylaşabilir veya tek kullanımlık kodla bağlanabilirsiniz. Etkileşimli oturum, terminal boyutlandırma, dosya aktarımı ve yerel port yönlendirme desteklenir.

ZeroLink; geçici ECDH P-256, HKDF ve AES-256-GCM ile tekrar saldırısı koruması kullanır. Bağlantı kodları tek kullanımlıktır ve beş dakika sonra geçersiz olur. Farklı ağlardaki bağlantı NAT koşullarına bağlıdır ve ayrıca yapılandırılmış bir TURN sunucusu gerektirebilir; terminal içeriği relay üzerinden geçse bile şifreli kalır.

## Yayın süreci

`main` dalına yapılan her gönderim ve pull request; JavaScript, yerel PTY, uygulama smoke, performans ve güvenlik testlerinden geçer. Bir `v*` etiketi ayrıca Windows x64, Apple Silicon ve Intel macOS paketlerini oluşturup GitHub Release sayfasına ekler.

## Lisans

MIT — ayrıntılar için [LICENSE](LICENSE). JetBrains Mono, [SIL Open Font License 1.1](src/fonts/OFL.txt) kapsamında sunulur.

Cupertino Terminal bağımsız bir yazılımdır; Apple Inc. ile bağlantılı değildir ve Apple tarafından onaylanmamıştır. macOS ve Terminal.app, Apple Inc. şirketinin ticari markalarıdır.

[NatureCo](https://natureco.me) ekosisteminin bir parçasıdır.
