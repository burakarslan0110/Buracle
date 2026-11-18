---
title: Güncelleme ve onarım
description: Buracle Stack'i güncellemek, buracle doctor çıktısını okumak, sık görülen sorunları çözmek ve kaldırmak.
order: 10
---

`buracle update` Buracle Stack'i, skill'lerini ve araç zincirini, her parçayı geldiği kaynaktan alarak günceller. `buracle doctor` neyin bozuk olduğunu ve nasıl düzeleceğini söyler.

## Güncelleme

```sh
buracle update
```

`buracle update` terminalde her parçayı kontrol eder ve yeni olanı adım adım uygular. Terminal yoksa yalnızca kontrol eder, uygulamak için `--yes` gerekir.

| Komut | Ne yapar |
|---|---|
| `buracle update --check` | Yalnızca en yeni sürümlerle karşılaştırır, durum çubuğu kaç güncelleme beklediğini gösterir |
| `buracle update self` | Buracle Stack checkout'unu çeker, ileri sarar ve `buracle install` çalıştırır |
| `buracle update skills` | Skill kaynaklarını ve `buracle skills add` ile eklediğin skill'leri günceller |
| `buracle update mcp` | Araç zincirindeki MCP sunucusu paketlerini günceller |
| `buracle update tools` | Homebrew araçlarını, dil sunucularını ve araç zincirinin diğer paketlerini günceller |
| `buracle update codegraph` | Tek bir parçayı adıyla günceller |

Güncelleme Buracle Stack'i ya da bir skill kaynağını değiştirdiyse yeniden derleyip kurar ve sürümü değişen her MCP sunucusu için el sıkışmasını yeniden çalıştırır. Bu kurulum başarısız olursa hook'lar eski çalışma kopyasıyla devam eder, checkout da önceki commit'ine döner. Kontrolü başarısız olan parça "kontrol edilemedi" olarak raporlanır ve güncel sayılmaz.

`update.minReleaseAgeDays`, o kadar günden genç npm ve PyPI sürümlerini bekletir. Varsayılan değer 0'dır, yani yeni sürümler hemen kullanılır.

## Sağlık kontrolleri

```sh
buracle doctor
```

Terminalde rapor her bölüm için sayılarıyla birlikte tek satır gösterir ve altına yalnızca uyarıları ve hataları, çözümleriyle birlikte dizer. Geçen satırları da görmek için `--all` ekle.

| Konu | Neyi kontrol eder |
|---|---|
| `config` | `~/.buracle/config.yaml`, `buracle` komutu, PATH ve hafıza klasörü |
| `runtime` | Hook'ların çalıştırdığı dondurulmuş çalışma kopyası, son 24 saatteki hook hataları ve bayat kilitler |
| `tools` | CLI araçları ve araç zinciri paketleri |
| `claude`, `codex`, `opencode`, `omp`, `qwen`, `pi`, `agy` | Tek bir harness: sürümü, adaptörünün kontrolleri ve Claude Code ile Codex için koruma hook'unun gerçek bir çalıştırması |
| `mcp` | Her MCP sunucusunu başlatıp 30 saniye içinde el sıkışmasını çalıştırır |
| `lsp` | Her dil sunucusunu başlatıp el sıkışmasını çalıştırır |
| `memory` | CortexDB, proje ve kişi beyinleri, bekleyen yakalamalar ve hafıza sunucusu |
| `index` | O anki projenin codegraph ve semble indeksleri |

`buracle doctor <topic>` tek bir bölümü çalıştırır. Bir harness adı verirsen `config`, `runtime` ve o harness kontrol edilir. Her şey yolundaysa çıkış kodu `0`, hata varsa `1`, uyarı varsa `2` olur.

## Sık görülen sorunlar

| Sorun | Çözüm |
|---|---|
| Her araç çağrısı "its guard hook could not run" mesajıyla reddediliyor | Önce `buracle doctor`, ardından `buracle install` çalıştır. Günlük dosyası `~/.buracle/logs/buracle.log` |
| Claude Code'un korunan çağrıları reddediliyor | Claude Code'u başlatan sürecin PATH'ine `bun` ekle, çünkü hook'ları `bun` komutu olarak çalışır |
| Codex, Buracle Stack hook'larını atlıyor | Codex'i aç ve hook'ları `/hooks` ile bir kez onayla. Bekleyen hook'ları `buracle doctor codex` listeler |
| Codex en düşük sürümünden eski | Codex'i güncelle, ardından `buracle install codex` çalıştır |
| Kurulum sırasında açık olan OpenCode pencereleri Buracle Stack'i görmüyor | Bu pencereleri yeniden başlat. Kurulum OpenCode'un arka plan servisini bir kez yeniden başlattı |
| nvm, fnm, volta ya da mise ile kurulan Node.js bulunamıyor | `buracle install` komutunu `node` çalışan bir shell'den çalıştır ya da Node'u harness'ın başladığı PATH'e ekle |
| Kurulum betiği Prerequisites adımında duruyor | Betiğin yazdırdığı komutu çalıştır, sonra betiği yeniden çalıştır |
| "Bun was installed but is not on PATH" | Yeni bir terminal aç ve betiği yeniden çalıştır |
| Bun çok eski | `bun upgrade` çalıştır |
| Durum çubuğunda `hooks` uyarısı görünüyor | Önce `buracle doctor runtime`, ardından `buracle install` çalıştır |
| 41777 portu dolu | Konsol bir sonraki boş portu kullanır, adresi `buracle mem ui` yazdırır |

## Kaldırma

```sh
buracle uninstall --dry-run
buracle uninstall
```

`buracle uninstall` yalnızca sahiplik defterine göre Buracle Stack'in yazdığı ve hâlâ Buracle Stack'in içeriğini taşıyan şeyleri kaldırır. Ayrıca Konsolu durdurur, kurulumun eklediği PATH satırlarını çıkarır ve indirdiği sistem araçlarını siler.

Yerinde kalanlar:

- `~/.buracle/brain` içindeki hafıza, her zaman ve `--purge-state` ile bile
- değiştirdiğin değerler ve Buracle Stack'ten önce de senin olan değerler
- `~/.buracle/config.yaml`
- `~/.buracle/toolchain` içindeki araç zinciri paketleri (`--purge-state` eklemezsen)
- projelerindeki `.codegraph/` indeksi ve `.claude/skills` bağlantıları gibi dosyalar. Komut bunları nasıl kaldıracağınla birlikte listeler
- Homebrew ile kurulan araçlar

`--purge-state`, `~/.buracle` içindeki geri kalan her şeyi de siler: durum dosyaları, oturumlar, günlükler, kurulum yedekleri ve kayıtları, araç zinciri ve dondurulmuş çalışma kopyaları. Herhangi bir adım başarısız olduysa hiçbir şey silinmez, böylece kayıtlar yeniden denemek için yerinde kalır.
