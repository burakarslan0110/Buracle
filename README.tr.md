<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/buracle-dark.svg">
    <img src="assets/buracle-light.svg" alt="buracle" width="408">
  </picture>
</p>

<p align="center"><a href="README.md">English</a> · <b>Türkçe</b></p>

<div align="center">

### Tek mühendislik kurulumu, tek hafıza, bütün kodlama ajanların

Tek kaynaktan yönetilen skill'ler, kurallar, MCP sunucuları, hook'lar ve korumalar, bütün ajanların paylaştığı tek bir hafıza ve kanıtla biten workflow'lar.

macOS · Linux, x64 ve arm64

```sh
curl -fsSL https://github.com/burakarslan0110/buracle/releases/latest/download/install.sh | bash
```

[![CI](https://github.com/burakarslan0110/buracle/actions/workflows/ci.yml/badge.svg)](https://github.com/burakarslan0110/buracle/actions/workflows/ci.yml)
[![Sürüm](https://img.shields.io/github/v/release/burakarslan0110/buracle?color=6D28D9&label=version)](https://github.com/burakarslan0110/buracle/releases/latest)
[![Lisans: MIT](https://img.shields.io/badge/license-MIT-A21CAF.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/bun-%E2%89%A5%201.4-B45309.svg)](https://bun.sh)

[Neden Buracle](#neden-buracle) · [Kurulum](#kurulum) · [Workflow'lar](#workflowlar) · [Hafıza](#hafıza) · [Ayarlar](#ayarlar) · [Harness'lar](#her-harnessa-ne-gelir)

</div>

## Neden Buracle

Buracle kullandığın kodlama ajanlarını tek bir kaynaktan kurar. Claude Code, Codex CLI, OpenCode, Oh My Pi, Qwen Code, Pi ve AGY CLI aynı skill'leri, MCP sunucularını, hook'ları ve korumaları alır, tek bir hafızayı paylaşır; birinde alınan karar ötekinde de bulunur. Workflow'lar planlar, test eder, inceler ve sonuç doğrulanmadan durmaz.

- `canonical/` içinde tek kurulum: `buracle install` her harness'ın kendi biçimini yedek, günlük ve geri alma ile yazar.
- Tek hafıza: her proje için bir beyin, bir de senin için.
- Kalıcı dosyaları, onay kapıları, önce testle çalışması ve bağımsız incelemeleri olan workflow'lar (`/plan-build`, `/goal-build`, `/bugfix`, `/requirements`).
- Onay sorusuz çalışma için korumalar: hook'lar yıkıcı komutları engeller, geri alması zor olanlardan önce sorar, gizli bilgileri maskeler.
- Dokuz MCP sunucusu ve altı dil sunucusu; yönlendirme hook'ları her soruyu doğru olana gönderir.
- Buracle Console: hafıza, plan incelemesi ve workflow ayarları için yerel bir web sayfası.

## Kurulum

Buracle macOS ve Linux'ta çalışır (Windows ve WSL yok). En az bir harness gerekir: [Claude Code](https://code.claude.com/docs/en/quickstart), [Codex CLI](https://developers.openai.com/codex/cli), [OpenCode](https://opencode.ai), [Oh My Pi](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent), [Qwen Code](https://github.com/QwenLM/qwen-code), [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) ya da [AGY CLI](https://antigravity.google). Buracle bulduğu her harness'ı kurar.

```sh
curl -fsSL https://github.com/burakarslan0110/buracle/releases/latest/download/install.sh | bash
```

Betik gerekirse Bun'ı kurar, `main` dalını `~/buracle` içine klonlar ve `buracle install` çalıştırır. Git ve curl sende olmalı (Linux'ta ayrıca unzip, Node.js yoksa libatomic1). Betik sudo ya da paket yöneticisi çalıştırmaz; Linux'ta dağıtımına uygun komutu yazdırır. Node.js, uv, ripgrep ve jq Homebrew ile gelir, yoksa `~/.buracle/toolchain/system` altına sabitlenmiş, sağlaması yapılan indirmeler olarak kurulur. İstersen önce betiği oku: [`install.sh`](scripts/install.sh).

`buracle install` her MCP ve dil sunucusunu kurar, her harness'ın yapılandırmasını bir transaction olarak yazar (yedek, günlük, sahiplik defteri, yalnızca o harness'ın geri alınması), beyni oluşturur, `~/.local/bin` klasörünü PATH'e ekler ve Buracle Console'u başlatır. Ayrıntılar `~/.buracle/logs/install-<tarih>.log` dosyasına gider. Elle değiştirdiğin değerler korunur. Betiği yeniden çalıştırmak günceller ve onarır.

Sonra:

1. Açık her Claude Code oturumunda `/reload-plugins` çalıştır. Öbür harness'larda bir kez oturum aç (`codex login`, `opencode auth login`, `omp login`; Qwen Code, Pi ve AGY CLI için kendi oturum açma adımları).
2. Her projede `buracle project sync` çalıştır. Bir `AGENTS.md` olup olmadığına bakar, `.agents/skills` klasörünü `.claude/skills` içine bağlar ve projenin beynini hazırlar.
3. En yeni Buracle, skill ve araçlar için `buracle update` çalıştır. `--check` yalnızca kontrol eder, `buracle update mcp codegraph` kapsamı daraltır.

`buracle uninstall` yalnızca sahiplik defterinin Buracle'ın yazdığını gösterdiği şeyleri kaldırır. Elle değiştirdiğin değerler kalır, `~/.buracle/brain` içindeki hafızaya hiç dokunulmaz.

## Workflow'lar

Harness'ını bir projede aç ve her zamanki gibi çalış: doğrudan bir istek, harness'ın kendi plan modu (onaylanan plan `docs/plan-build/` içine kaydedilir; OpenCode taslak kaydeder) ya da bir Buracle workflow'u. Üçü de aynı korumalar ve aynı hafızayla çalışır. Her depoda bir kez `/project-rules` çalıştır; her harness'ın izlediği bir `AGENTS.md` yazar. Codex'te bu sayfada `/` yazan yere `$` yaz; Pi'de `/skill:` (örneğin `/skill:plan-build`).

| Workflow | Ne zaman | Ne elde edersin |
|---|---|---|
| `/plan-build` | Kod yazılmadan önce incelenmiş, onaylı bir plan istiyorsan | `docs/plan-build/` içinde plan, her değişiklikten önce başarısız bir test, incelemeler, gerçek program çalıştırması ve onayın |
| `/goal-build` | Son durum belli, yol yaparken bulunacaksa | `docs/goal-build/` içinde geçti/kaldı ölçütleriyle kilitli bir sözleşme, hakemli yapım turları, son doğrulama |
| `/bugfix` | Tek bir davranış bozuk ve düzeldiğinin kanıtını istiyorsan | Yeniden üretilen hata, `file:line` olarak kök neden, başarısız test, düzeltme, uçtan uca kontrol |
| `/requirements` | Problem ya da kapsam belirsizse | Birkaç tur soru ve `docs/requirements/` içinde onaylı bir PRD |

- Bir stop guard, plan doğrulanana kadar turu açık tutar. Duraklatmak için stop, wait ya da hold on de.
- İsteğin ardından `--worktree`, `--new-branch` ya da `--current-branch` işin nerede yapılacağını belirler; worktree'de çalışan iş squash merge ile geri birleştirilir.
- `buracle plan audit` hiçbir görevin planlamadığı değişiklikleri işaretler.

Ayrıca: `/research` (kaynak gösteren araştırma), `/inspect` (bir soruyu çalışan kodda izler, hiçbir şeyi değiştirmez), `/dead-code` (aşamalı kaldırma planı, hiçbir şeyi değiştirmez), `/project-rules`, `/new-skill`, `/find-skill`, `/ab-test` (bir skill ya da kural değişikliğinin ajanın davranışını değiştirip değiştirmediğini ölçer), `/brain` (Buracle Console'u açar), `/remember <metin>`, `/aside <soru>` ve `/buracle-status`.

Dört kısa kural her oturumda yüklenir ve birlikte 8 KB'ın altındadır (`buracle rules lint` denetler). Ayrıntılar, ajanın gerektiğinde okuduğu skill referanslarında durur. Planlar, PRD'ler ve raporlar senin dilini izler; yalnızca Buracle'ın okuduğu işaretler İngilizce kalır.

## Hafıza

![Buracle Console'un Beyin görünümü: projenin hafızası, bölgeleri hafıza türleri olan bir beyin olarak çizilmiş](assets/brain-overview.png)

Hafıza tek bir [CortexDB](https://github.com/liliang-cn/cortexdb) dosyasında, `~/.buracle/brain/brain.db` içinde durur; her proje için ve senin için birer kovası vardır. Her harness ona `buracle-memory` MCP sunucusuyla ulaşır; sunucunun altı aracının her birinin `buracle mem` altında bir CLI karşılığı vardır. Tasarım için [ARCHITECTURE.md](ARCHITECTURE.md), nelerin doğrulandığı için [COMPATIBILITY.md](COMPATIBILITY.md) dosyalarına bak.

- Oturum başlangıcında ajan tercihlerini, projenin kilit hafızalarını ve iş yarıda kaldıysa bir devir notunu alır. Belirttiğin bir tercih ("her zaman", "asla", "bundan sonra") hemen kaydedilir. Sıkıştırmadan önce plan ve todo durumu bir devir hafızasına yazılır.
- Oturum bitince tek bir `buracle mem finalize` çalıştırması oturum hafızasını yazar ve kullandığın harness'ın modelinden saklamaya değer kararları, tuzakları ve prosedürleri ister. Güvenilir bulgular çıkarım olarak kaydedilir, gerisi yakalama olarak bekler. Bir bulgu senin hafızalarından hiçbirini değiştirmez: yanına, çelişen diye işaretlenerek konur. `buracle mem capture` aynısını istek üzerine yapar, `buracle mem doctor` neyin borç kaldığını listeler.
- Arka planda başka bir şey çalışmaz. Oturumlar 45, devirler 14 gün sonra süresi dolar. `buracle mem backup` ve `buracle mem restore` beyin dosyasını kopyalar; bir oturum sonu da en yeni kopya bir günden eskiyse yenisini alır (en yeni 10 tutulur).

Model çağrıları zaten kullandığın bir harness'ın CLI'ı üzerinden gider, yani API anahtarı gerekmez; 5 saatlik kullanımı %75'in ya da haftalık kullanımı %85'in üstündeki harness atlanır. Gizli bilgiler yazılmadan önce maskelenir, `<private>…</private>` blokları hiç saklanmaz, `memory.exclude` içindeki klasörler hiç kaydedilmez.

### Buracle Console

`/brain` ya da `buracle mem ui --open` Console'u `http://localhost:41777` adresinde açar (başka port için `buracle mem ui --port N`). Kurulumla ya da bir oturum başlangıcıyla başlar, bir harness oturumu açıkken ayakta kalır ve sonuncusu bittikten yaklaşık bir dakika sonra durur (boşta durma süresini `BURACLE_UI_IDLE_MS` ayarlar). `buracle mem ui --stop` durdurur; `buracle config set memory.ui.autostart false` yalnızca `buracle mem ui` ile başlamasını sağlar. Beyni (`/` arar, `1` ile `7` arası bir bölgeyi açar, `G` ağı gösterir), her hafızayı düzenleme, emekli etme, geri getirme ve silme ile, planlar, sözleşmeler, PRD'ler ve diff'ler için ajana not iğneleyebildiğin bir inceleme sayfasını ve bir sağlık görünümünü (`H`) gösterir.

#### Ayarlar

`S` tuşuna bas. Workflow anahtarları plan-build, goal-build ve bugfix'in her harness'ta nasıl çalışacağını belirler. Burada ya da `buracle config set plan.<key> <value>` ile değiştirirsin. Değişiklik hemen `~/.buracle/config.yaml` içine yazılır; çalışan bir goal-build kilitlediği değerleri korur. Bir ajan onay, inceleme ve doğrulama anahtarlarını değiştiremez.

| Ayar | Anahtar | Varsayılan |
|---|---|---|
| Yapmadan önce planı onayla | `plan.planApproval` | açık |
| Doğrulanmış sonucu onayla | `plan.resultApproval` | açık |
| Kendi dalında, bir worktree'de yap | `plan.branchIsolation` | açık |
| Planlarken açıklayıcı sorular sor | `plan.questions` | açık |
| Plan, değişiklik ve goal sözleşmesinin bağımsız incelemesi | `plan.reviews.plan`, `plan.reviews.changes`, `plan.reviews.goal` | açık |
| Başka bir harness'tan salt okunur ikinci görüş | `plan.reviews.companion` | `off`; ya da `auto`, `claude`, `codex`, `opencode`, `omp` |
| Ölçütleri geçen bir goal-build'i doğrula | `plan.goalVerification` | açık |
| Onaydan sonra modeli değiştirmek için dur | `plan.modelSwitch` | `off`; ya da `manual` |
| Harness'ın kendi plan modunda planla | `plan.nativePlanMode` | `off`; ya da `on` |

## Korumalar

Korumayı hook'lar yapar, bu yüzden harness'lar onay sorusu olmadan çalışır:

- Yıkıcı komutlar reddedilir (`/` ya da `~` üzerinde `rm -rf`, main'e force push, `curl | sh`, `mkfs`, bir aygıta `dd`).
- Gizli bilgilere (`.env`, anahtarlar, kimlik bilgileri), `~/.ssh`, `~/.aws` ve Buracle'ın kendi kurulumuna yazmak reddedilir.
- Geri alması zor komutlar (force push, `reset --hard`, rebase, amend, dal silme, `git clean`) harness'ın kendi penceresinde, bir kez izin verene, oturum için izin verene ya da reddedene kadar bekler. Konağın penceresi yoksa [harness sınırlarına](#harness-sınırları) bak.
- Araç çıktısındaki anahtarlar, belirteçler ve parolalar maskelenir.
- Claude Code, Codex, Qwen Code ve AGY CLI'da yüklenemeyen ya da karar veremeyen bir hook komutu reddeder ve `buracle doctor`'ı anar.

`~/.buracle/config.yaml` içindeki `guards.bash.extraDeny` ve `guards.write.protect` kendi kalıplarını ekler.

## Araçlar

| MCP sunucusu | Ne için |
|---|---|
| `buracle-memory` | Beyin |
| `context7` | Kütüphane ve framework dokümanları |
| `codegraph` | Semboller, çağıranlar ve bir değişikliğin etkisi |
| `semble` | Anlamsal kod arama |
| `web-search`, `web-fetch` | API anahtarsız web araması; sayfaları başsız tarayıcıda okuma |
| `grep` | Açık GitHub depolarından kod örnekleri (grep.app) |
| `chrome-devtools` | Bir Chrome tarayıcısını yönetir (Oh My Pi'de yok, onun kendi tarayıcısı var) |
| `lsp` | Codex ve OpenCode için dil sunucusu tanılamaları ve gezinme |

Her oturum her sunucu için ince bir yönlendirici çalıştırır. `context7`, `semble`, `web-search` ve `web-fetch` makine başına tek bir backend'i paylaşır; backend ilk çağrıda başlar ve son oturum bittikten 60 saniye sonra durur (`buracle config set mcp.shared false` her oturuma kendi kopyasını verir). `buracle mcp disable <id>` (tek harness için `--harness <h>`), `enable`, `list`, `status` ve `stop` onları yönetir.

`context7`, [context7.com/dashboard](https://context7.com/dashboard) adresinden alınan bir API anahtarıyla daha çok isteği yanıtlar: `pbpaste | buracle mcp key context7` anahtarı `~/.buracle/secrets/mcp-keys.json` içine kaydeder (Linux'ta `wl-paste` ya da `xclip -o`). Bir oturumun ortamındaki `CONTEXT7_API_KEY` öncelikli olur; `buracle mcp key` her anahtarın nereden geldiğini gösterir, `--clear` kayıtlı olanı kaldırır.

Araç zinciri ayrıca `rg`, `ast-grep`, `jq`, `gh`, `tmux`, `ruff`, `shellcheck`, `golangci-lint` ve altı dil sunucusu getirir (pyright, typescript-language-server, gopls, rust-analyzer, csharp-ls, jdtls). Birkaç proje barındıran bir klasörde ajan `buracle index ensure --cwd <project>` çalıştırır; her düzenlemeden sonra eşleşen denetleyici çalışır ve bulguları ajana döner.

## Her harness'a ne gelir

Yedisi de aynı 26 hook'u, skill'leri, hafızayı ve korumaları alır. Kural dosyaları ve inceleme ajanları Claude Code, Codex CLI, OpenCode, Oh My Pi ve AGY CLI için kurulur (AGY CLI'da `buracle` eklentisi olarak, yerel yol kurallarıyla); Qwen Code ve Pi için Buracle hook'ları, MCP sunucularını, skill'leri ve konağın bir yeri varsa durum çubuğunu kurar.

| | Nasıl takılır | Skill'ler | Durum ve ilerleme | İpuçları | Geri alması zor komutlar |
|---|---|---|---|---|---|
| Claude Code | Mod'lu bir eklenti | Eklenti kopyası | Bant, paneller, durum çubuğu | Spinner | Claude Code penceresi |
| Codex CLI | `hooks.json`, `config.toml`, `AGENTS.md` bloğu, exec-policy kuralları | `~/.agents/skills`; `$plan-build` | Yerel öğeler, tek satırlık bildirimler | Yok | Codex'in istemi |
| OpenCode | Sunucu ve TUI eklentileri | `~/.agents/skills` | Bant, altlık | Ana ekran | TUI penceresi, soru aracı |
| Oh My Pi | Extension'lı bir omp eklentisi | `~/.agents/skills` | Widget, panel, yerel ön ayar | Yok | omp'nin seçim penceresi |
| Qwen Code | `~/.qwen/settings.json` içinde hook'lar ve MCP | `~/.agents/skills` | Durum çubuğu komutu | Yükleme cümleleri | Ret, ajana ne soracağını söyler |
| Pi | Bir extension; `mcp.json` içinde MCP | `~/.agents/skills`; `/skill:plan-build` | Widget bandı, altlık | Çalışma mesajı | Pi'nin seçim penceresi |
| AGY CLI | `~/.gemini/config` içinde `hooks.json`, `mcp_config.json`, bir `buracle` eklentisi (kurallar, inceleme ajanları) | AGY'nin skills klasöründe bağlantılar | Durum çubuğu komutu | Yok | Ret, ajana ne soracağını söyler |

`/brain`, `/remember`, `/aside` ve `/buracle-status` Claude Code, OpenCode ve Oh My Pi'de vardır; öbür dördü `buracle` altındaki CLI karşılıklarını kullanır (Codex `/aside` komutunu `/side`'a eşler). Dil sunucuları: Claude Code ve Oh My Pi kendilerininkini, Codex ve OpenCode Buracle'ın `lsp` sunucusunu kullanır, gerisinde yoktur. Plan modu: Claude Code ve Qwen Code kendi modunu kullanır; Codex planı uygulamayı seçtiğinde, OpenCode taslak olarak, Oh My Pi onayda kaydeder; Pi ve AGY CLI'da yerleşik mod yoktur (ajan senden bir tane açmanı ister).

Bütün harness'lar yerel hook'larını aynı yedi olaya eşler (oturum başlangıcı, istem, araçtan önce ve sonra, stop, sıkıştırmadan önce, oturum sonu) ve kararı ortak bir pipeline verir; ret `Buracle H<nn>: …` biçiminde görünür. Buracle, Claude Code, Codex ve Oh My Pi'nin yerleşik hafızasını kapatır.

### Harness sınırları

[`src/adapters/shared/host-limits.ts`](src/adapters/shared/host-limits.ts) bir konakta Buracle'ın ihtiyaç duyduğu bir şeyin nerede eksik olduğunu ve yedek yolu kaydeder. `buracle doctor <harness> --all` her kaydı listeler.

<details>
<summary><b>Kaydedilmiş her konak sınırı ve yedek yolu</b></summary>

| Kayıt | Harness | Konakta ne yok | Yedek yol |
|---|---|---|---|
| `codex.consent-dialog` | Codex | Hook kullanıcıya soramaz; `codex exec`, `--yolo` ve `-a never` onay istemi göstermez | Ret ajana ne soracağını söyler |
| `codex.background-wait` | Codex | Bir arka plan komutu bitince hiçbir şey turu uyandırmaz | Stop guard turu tutar |
| `codex.quiet-stop-feedback` | Codex | Stop hook'u turu yalnızca bir engelle sürdürür | Guard'ın gerekçesi o isteme girer |
| `codex.commands-without-turn` | Codex | Özel slash komutu yok | `$memory`, CLI karşılıkları, Codex'in `/side` komutu |
| `codex.live-exec-mask` | Codex | Çalışan bir komutun `write_stdin` yoklamaları hiçbir hook'a ulaşmaz | Tamamlanan her shell ve MCP sonucu maskelenir |
| `codex.failed-mcp-mask` | Codex | PostToolUse yalnızca başarılı çağrıda çalışır | Başarılı her sonuç maskelenir |
| `codex.live-panes` | Codex | Hook'lar panel, widget ya da pencere alamaz | `buracle mem status`, `buracle plan status`, tek satırlık bildirimler (`workflow.codexNotices`) |
| `codex.custom-status-line` | Codex | Altlık yalnızca Codex'in kendi öğelerini gösterir | Buracle yerel öğeleri seçer |
| `codex.summary-keep-list` | Codex | Uzaktan sıkıştırma `compact_prompt`'u yok sayar | Devir hafızası durumu taşır |
| `opencode.consent-dialog` | OpenCode | Pencere TUI eklentisini ister; web, masaüstü, API ve `opencode run` onu yüklemez | Ret ajana `question` aracını kullanmasını söyler |
| `opencode.approved-plan-capture` | OpenCode | Plan ajanının onay aracı ya da olayı yok | Oturum plan ajanından çıkınca taslak plan |
| `opencode.native-plan-approval` | OpenCode | Plan ajanından çıkmak onay sayılmaz | Plan taslak olarak doldurulur, plan-build sana sorar |
| `opencode.goal-command` | OpenCode | Yerel goal komutu yok | goal-build özeti koşulu önce belirtir |
| `opencode.quiet-stop-feedback` | OpenCode | Oturum durmadan önce çalışan eklenti hook'u yok | Oturum bittikten sonra sınırlı yeniden istem |
| `opencode.stop-veto` | OpenCode | Durmak üzere olan oturumu tutacak hook yok | Oturum bittikten sonra sınırlı yeniden istem |
| `opencode.subagent-stop-hold` | OpenCode | Alt ajan durma hook'u yok | Bir not ajandan inceleyiciyi bir kez sürdürmesini ister |
| `opencode.rate-windows` | OpenCode | Kota API'si yok; pencereler yanıt başlıklarından gelir | Bir yanıt taşıyana kadar 5 saatlik ve 7 günlük bölümler boş kalır |
| `omp.companion-shell` | Oh My Pi | Print modu bash'i salt okunur komutlarla sınırlayamaz | İkinci görüş yalnızca read, grep ve glob alır |
| `agy.no-compaction-event` | AGY CLI | Sıkıştırmadan önce ya da sonra olay yok | Hafıza bağlamı SessionStart'ta gelir; bağlam boyutu her model çağrısından önce izlenir |
| `agy.commands-without-turn` | AGY CLI | Model turu olmadan çalışan özel komut yok | İş akışları `/<id>` skill'idir; kurallar `/remember`, `/brain`, `/aside` ve `/buracle-status` için CLI karşılıklarını söyler |
| `agy.no-subagent-result` | AGY CLI | Hook alt ajanın sonucunu görmez, bu yüzden inceleme raporu denetimi (H19) yok | İnceleme adımları raporu kendileri doğrular |
| `agy.no-session-end` | AGY CLI | Konuşma sonu olayı yok, yalnızca tur başına Stop | Hafıza her Stop'ta yakalanır |

</details>

En düşük harness sürümleri (`src/engine/update/min-versions.ts`); bunların altında `buracle doctor` hata raporlar:

| Claude Code | Codex CLI | OpenCode | Oh My Pi | Qwen Code | Pi | AGY CLI |
|---|---|---|---|---|---|---|
| 2.1.290 | 0.154.0 | 2.0.20 | 18.8.0 | 0.26.1 | 1.5.2 | 1.5.9 |

## buracle komutu

Bir menü için terminalde `buracle` çalıştır (kur ya da onar, güncelle, sağlık kontrolü, hafıza, çıkış). Doğrudan kullanacağın komutlar:

- `buracle install [<harness>…]`: ilk kurulum ve onarım; bulduğu her harness için ya da adını verdiklerin için.
- `buracle update [--check]`: her parçayı kendi kaynağından günceller.
- `buracle doctor [<konu>] [--all]`: hook'ları, MCP sunucularını, hafızayı ve kod indekslerini kontrol eder, yalnızca sorunları düzeltmeleriyle gösterir.
- `buracle config`: `get`, `set` ve `unset`.
- `buracle uninstall`: Buracle'ın kurduklarını kaldırır, hafızaya dokunmaz.

Ajanlar daha çok komut kullanır (`plan`, `worktree`, `mem`, `skills`, `project`). `buracle help --all` hepsini listeler, `buracle help <komut>` birini açıklar.

## Geliştirme

```sh
bun install
bunx tsc --noEmit -p .
T=$(mktemp -d) && HOME=$T BURACLE_HOME=$T/.buracle bun src/cli/main.ts build --check
bun test
```

CI bunları macOS (arm64) ve Linux (x64) üzerinde çalıştırır. İş `dev` dalına iner; bütün kontroller geçer ve yayımlanan dosyalar değişmişse CI sonraki yama sürümünü `main` dalına tek commit olarak yazar (`tests/` ve `bunfig.toml` olmadan) ve `v<sürüm>` yayımlar. Yeni bir hat için `package.json` içinde major ya da minor sürümü yükselt.

Bir değişiklik göndermeden önce [`AGENTS.md`](AGENTS.md), [`CONTRIBUTING.md`](CONTRIBUTING.md) ve [`SECURITY.md`](SECURITY.md) dosyalarını oku. Bir hata bulduysan ya da bir özellik eksikse [bir issue aç](https://github.com/burakarslan0110/buracle/issues).

## Lisans

[MIT](LICENSE).
