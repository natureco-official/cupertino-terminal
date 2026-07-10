# NatureCo — Marka İmzası Standardı

> Tüm NatureCo ekosistem ürünleri bu imzayı **aynı** şekilde taşır. Amaç: kullanıcı
> hangi ürüne girerse girsin "bu NatureCo" desin ve **natureco.me**'ye (markanın kalbi)
> geri aksın. Bu dosya tek kaynaktır; her ürün buna uyar. **Repolar taşınmaz** — birlik
> imza + geri-bağlantıyla sağlanır, yapıyla değil.

## Kalp
- **Marka**: NatureCo
- **Merkez / hub**: **natureco.me** (asıl ürün; tüm ürünler buraya link verir)
- **GitHub org**: natureco-official (bazı ürünler kişisel hesapta kalabilir — sorun değil, imza markayı taşır)

## İmza metni (her yerde birebir aynı)
- 🇹🇷 **NatureCo ekosisteminin parçası — [natureco.me](https://natureco.me)**
- 🇬🇧 **Part of the NatureCo ecosystem — [natureco.me](https://natureco.me)**

Ürün adlandırma: **NatureCo <Ürün>** (örn. "NatureCo CLI", "NatureCo Developers").
Bağımsız isimli ürünler (Cupertino Terminal, CodeDNA, Urðr) adını korur ama imzayı taşır:
"Cupertino Terminal · a NatureCo project".

## Renk paleti (ana platformdan — Tailwind uyumlu)
| Rol | Hex | Not |
|---|---|---|
| Primary — Zümrüt | `#10B981` | vurgu, düğme, marka yeşili |
| Primary açık | `#34D399` | gradyan üst / hover |
| Secondary — Turkuaz | `#22D3EE` | ikincil vurgu, linkler |
| Uzay siyahı (bg) | `#060B10` | koyu zemin |
| Yüzey | `#0E1621` | kart/panel |
| Metin | `#F2F5F7` / muted `#8A97A3` | |

Marka gradyanı: `linear-gradient(135deg, #34D399, #22D3EE)`.

## Tipografi
- **UI**: Inter (Variable) — `@fontsource-variable/inter`
- **Başlık/Display**: Baloo 2 — `@fontsource/baloo-2`
- **Mono**: JetBrains Mono (terminal/kod ürünlerinde)

## Uygulama kuralları (her ürün)
1. **README footer** (en altta):
   ```md
   ---
   <sub>Part of the **NatureCo** ecosystem — [natureco.me](https://natureco.me) · NatureCo ekosisteminin parçası</sub>
   ```
2. **Uygulama içi imza**: ayarlar/hakkında/footer'da bir satır + natureco.me linki.
3. **CLI**: banner altında tek satır imza; `--version`/`about` çıktısında natureco.me.
4. **Renk/font**: yukarıdaki palet + tipografi; yeni yüzeyler markaya uysun.
5. **Geri-bağlantı**: her ürün en az bir yerde natureco.me'ye tıklanır link verir.

## Ürün-ürün uygulama takip listesi
- [x] **Cupertino Terminal** — README + INSTALL footer + uygulama içi imza (bu repoda referans uygulama)
- [ ] **NatureCo CLI** (natureco-official/natureco-cli) — banner + README footer
- [ ] **CodeDNA** (natureco-official/codedna) — README footer + landing
- [ ] **NatureCo Developers** portal — footer imzası
- [ ] **NatureCo SDK** (natureco-official/natureco-sdk) — README footer
- [ ] **Urðr** (natureco-official/urdr) — README footer
- [ ] **Landing** (natureco.me) — zaten kalp; imza gerekmez

_Not: cli/codedna/portal gibi ayrı repolar kendi commit'leriyle güncellenir (Mac tarafındaki Claude ile koordineli)._
