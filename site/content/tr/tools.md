---
title: Araçlar
description: Dokuz MCP sunucusunun her birinin ne kattığı ve nereden geldiği, sunucuların nasıl paylaşılıp yönetildiği, context7 anahtarı, araç zinciri, dil sunucuları ve her düzenlemeden sonraki kontroller.
order: 7
---

Buracle Stack dokuz MCP sunucusu ve altı dil sunucusu kurar, yönlendirme hook'ları da her soruyu o iş için yapılmış araca gönderir.

## MCP sunucuları

İki istisna dışında aşağıdaki sunucuların hepsi her harness'a gider: `chrome-devtools` tarayıcı aracı yerleşik olan Oh My Pi'ye kurulmaz, `lsp` ise yalnızca Codex ve OpenCode'a gider. Buracle Stack'in kullandığı bütün açık kaynak projeler [Açık kaynak](credits.md) sayfasında.

### buracle-memory

buracle-memory ortak beyindir. Her harness aynı [hafızada](memory.md) altı araçla arar, okur ve yazar: `memory_search`, `memory_get`, `memory_write`, `memory_update`, `memory_status` ve `memory_context`. Bir oturum yalnızca o anki projenin kovasını ve seninkini görür.

- Yönlendirmenin buraya gönderdiği soru: "Geçen sefer önbellek için neden SQLite seçmiştik?"
- Kaynak: Buracle Stack'in bir parçası (`buracle mcp memory`, MIT), [CortexDB](https://github.com/liliang-cn/cortexdb) (MIT) üzerinde çalışır.

### context7

context7, projenin kullandığı kütüphane sürümünün güncel belgelerini ve kod örneklerini getirir. Böylece ajan API'leri tahmin etmez. Önce kütüphane adını bir Context7 kimliğine çevirir, ardından o kimliğin belgelerini sorgular. Sürüm önemliyse sorguya sürümü de ekler.

- Yönlendirmenin buraya gönderdiği soru: "Next.js 15'te önbellek kayıtlarını nasıl etiketlerim?"
- Kaynak: Upstash'in [Context7](https://github.com/upstash/context7) projesi, MIT. Buracle Stack `@upstash/context7-mcp` npm paketini çalıştırır, belgeler Upstash'in barındırdığı servisten gelir.

### codegraph

codegraph, o anki depodaki sembolleri, çağıranlarını, çağrılanlarını ve etkilerini yerel bir grafikte tutar. Böylece her değişiklik etki alanıyla gelir. Tek bir `codegraph_explore` çağrısı ilgili sembollerin kaynak kodunu ve aralarındaki çağrı yollarını döndürür. Sunucu çalışırken bir dosya izleyici indeksi güncel tutar.

- Yönlendirmenin buraya gönderdiği soru: "sumItems'ı kim çağırıyor, değiştirirsem ne bozulur?"
- Kaynak: colbymchenry'nin [CodeGraph](https://github.com/colbymchenry/codegraph) projesi, MIT. Buracle Stack `@colbymchenry/codegraph` npm paketini telemetrisi ve güncelleme denetimi kapalı olarak çalıştırır.

### semble

semble kodu ne yaptığına göre bulur. API anahtarı istemeden CPU üzerinde çalışır, yerel klasörlerde ya da git URL'lerinde arar ve bilinen bir konuma benzeyen kodu bulur (`find_related`).

- Yönlendirmenin buraya gönderdiği soru: "Kullanıcı girdisindeki tarihleri nerede ayrıştırıyoruz?"
- Kaynak: MinishLab'in [Semble](https://github.com/MinishLab/semble) projesi, MIT. Buracle Stack `semble[mcp]` paketini PyPI'dan uv ile Python 3.12 üzerine kurar, Hugging Face telemetrisini kapatır.

### web-search

web-search, API anahtarı ya da oturum açma istemeden web'de arar. Varsayılan motor DuckDuckGo'dur. Sonuçlar başlık, URL ve açıklamayla gelir.

- Yönlendirmenin buraya gönderdiği soru: "Son Bun sürümünde neler değişti?"
- Kaynak: Aas-ee'nin [Open-WebSearch](https://github.com/Aas-ee/open-webSearch) projesi, Apache-2.0. Buracle Stack `open-websearch` npm paketini çalıştırır.

### web-fetch

web-fetch sayfayı Playwright üzerinden başsız bir Chromium'da açıp ana içeriğini Markdown, HTML ya da düz metin olarak döndürür. JavaScript gerektiren sayfalar da böylece okunur. `fetch_urls` birden çok sayfayı aynı anda okur.

- Yönlendirmenin buraya gönderdiği soru: "Bu adresteki geçiş notlarını oku."
- Kaynak: jae-jae'nin [Fetcher MCP](https://github.com/jae-jae/fetcher-mcp) projesi, MIT (npm manifesti ISC diyor). Buracle Stack `fetcher-mcp` npm paketini çalıştırır ve her çağrıya en çok 180 saniye tanır.

### grep

grep, açık GitHub kodunda gerçek kullanım örneklerini bulur. Düz metinle ya da düzenli ifadeyle arar, sonuçları dile, depoya ya da yola göre süzer.

- Yönlendirmenin buraya gönderdiği soru: "Başka projeler Vitest çalışma alanlarını nasıl yapılandırıyor?"
- Kaynak: Vercel'in barındırdığı [grep.app](https://grep.app) servisi. Buracle Stack uzak MCP adresine (`https://mcp.grep.app`) bağlanır, bir şey kurmaz.

### chrome-devtools

chrome-devtools gerçek bir Chrome'u yönetir: sayfada gezinme, tıklama ve yazma, ekran görüntüsü ve sayfa anlık görüntüsü, konsol mesajları, ağ istekleri, performans izleri ve Lighthouse denetimleri.

- Yönlendirmenin buraya gönderdiği soru: "Ödeme sayfası Pay'e tıklayınca konsola neden hata yazıyor?"
- Kaynak: Google'ın Chrome DevTools ekibinin [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) projesi, Apache-2.0. Buracle Stack onu yalıtılmış bir profille, kullanım istatistikleri ve CrUX sorguları kapalı olarak çalıştırır.

### lsp

lsp, altı [dil sunucusunun](#araç-zinciri) tanı, hover, tanım, başvuru ve sembol bilgisini Codex ve OpenCode'a getirir. Claude Code ve Oh My Pi aynı sunuculara yerleşik LSP desteğiyle ulaşır.

- Yönlendirmenin buraya gönderdiği soru: "Bu dosyada düzenlemeden sonra hâlâ tip hatası var mı?"
- Kaynak: Buracle Stack'in bir parçası olan köprü (`buracle lsp mcp`, MIT). Dil sunucuları [Araç zinciri](#araç-zinciri) bölümünde.

## Yönlendirme

`routing.strictness` değeri `enforce` iken (varsayılan), eşleşen MCP sunucusu sağlıklı olduğu sürece harness'ın yerleşik web araması ve sayfa getirme araçları reddedilir. Ret mesajı hangi aracın kullanılacağını söyler. `nudge` çağrıya bir notla izin verir, `off` ise yönlendirmeyi kapatır. Başlayamayan bir sunucu 10 dakika boyunca çalışmıyor olarak işaretlenir ve yönlendirme bu süre içinde yerleşik araca izin verir.

## Paylaşılan sunucular

Her oturum her sunucu için ince bir yönlendirici çalıştırır. `context7`, `semble`, `web-search` ve `web-fetch` makine başına tek bir backend paylaşır:

- ilk gerçek çağrı backend'i başlatır,
- 10 dakika boyunca çağrı yapmayan oturum backend'i bırakır,
- backend son oturum kapandıktan 60 saniye sonra durur.

`chrome-devtools` ilk çağrıda başlar ve 10 dakika boşta kalınca durur. `buracle config set mcp.shared false` her oturuma her sunucunun ayrı bir kopyasını yeniden verir.

## Sunucuları yönetmek

| Komut | Ne yapar |
|---|---|
| `buracle mcp list` | Her sunucuyu, her harness'taki durumunu ve onu başlatan komutu listeler |
| `buracle mcp status` | Çalışan her Buracle Stack MCP sürecini rolü, oturumları, bellek kullanımı ve çalışma süresiyle gösterir |
| `buracle mcp disable <id>` | Bir sunucuyu her harness'ta, `--harness <h>` ile de yalnızca birinde kapatır |
| `buracle mcp enable <id>` | Sunucuyu aynı biçimde yeniden açar |
| `buracle mcp stop [<id>]` | Paylaşılan backend'leri hemen durdurur. Sonraki çağrı onları yeniden başlatır |

`disable` sonrasında harness'ın bir sonraki oturumu o sunucunun araçlarını listelemez ve yönlendirme, sunucunun yerini tuttuğu yerleşik araca izin verir.

## context7 anahtarı

`context7`, [context7.com/dashboard](https://context7.com/dashboard) adresinden alacağın bir API anahtarıyla daha çok isteği yanıtlar. Anahtar shell geçmişine düşmesin diye onu pipe ile aktar:

```sh
pbpaste | buracle mcp key context7
```

Linux'ta `pbpaste` yerine `wl-paste` ya da `xclip -o` kullan. Anahtar, yalnızca senin kullanıcının okuyabildiği `~/.buracle/secrets/mcp-keys.json` dosyasına yazılır. Bir oturumun ortamında `CONTEXT7_API_KEY` tanımlıysa kayıtlı anahtar yerine o kullanılır. Her anahtarın kaynağını `buracle mcp key` gösterir. Kayıtlı anahtarı `buracle mcp key context7 --clear` siler.

## Kod indeksleri

`codegraph` ve `semble` projenin indeksini okur. İndeksi olmayan bir projede açılan codegraph sunucusu önce bir indeksleme başlatır ve 4 saniyeye kadar bekler. Sunucu çalıştığı sürece indeksi güncel tutar. Birkaç projeyi barındıran bir klasörde ajan, üzerinde çalıştığı proje için `buracle index ensure --cwd <project>` çalıştırır.

| Komut | Ne yapar |
|---|---|
| `buracle index status` | Projenin indekslerinin durumunu ve son hatayı gösterir |
| `buracle index ensure` | Eksik olanı oluşturur, var olanı yeniler |
| `buracle index rebuild` | codegraph indeksini sıfırdan oluşturur |

Ev klasörün, `~/.buracle` ve `index.exclude` içindeki klasörler hiçbir zaman indekslenmez.

## Araç zinciri

Araç zinciri ayrıca `rg`, `ast-grep`, `jq`, `gh`, `tmux`, `ruff`, `shellcheck`, `golangci-lint` ve altı dil sunucusunu getirir:

| Dil sunucusu | Dil | Gerektirdiği |
|---|---|---|
| pyright | Python | |
| typescript-language-server | TypeScript ve JavaScript | |
| gopls | Go | Go |
| rust-analyzer | Rust | Bir Rust araç zinciri (cargo) |
| csharp-ls | C# | .NET SDK |
| jdtls | Java | Java 21 ya da daha yenisi |

Claude Code ve Oh My Pi bu sunucuları yerleşik LSP desteğiyle çalıştırırken Codex ve OpenCode onlara `lsp` MCP sunucusu üzerinden ulaşır. Qwen Code, Pi ve AGY CLI'da dil sunucusu yok. `buracle lsp check` her sunucuyu başlatıp el sıkışmasını çalıştırır.

## Her düzenlemeden sonraki kontroller

Bir düzenlemeden sonra uygun denetleyici çalışır ve bulguları ajana geri döner: Python için ruff, TypeScript ve JavaScript için eslint, Go için go vet, gofmt ve golangci-lint, shell betikleri için shellcheck, C# için `dotnet format`. Her denetleyici projenin yapılandırmasını kullanır. Kurulu olmayan denetleyici oturum başına bir kez, nasıl kurulacağıyla birlikte anılır. `buracle config set checkers.enabled false` kontrolleri kapatır, `checkers.languages` ise dilleri seçer.
