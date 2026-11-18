---
title: Harness'lar
description: Yedi harness'ın her birine ne geldiği, komutları ve plan modu, hook'ların dayandığı olaylar, kayıtlı harness sınırları ve en düşük sürümler.
order: 8
---

Yedi harness'ın hepsi aynı 26 hook'u, aynı skill'leri, aynı hafızayı ve aynı korumaları alır. Harness'lar, Buracle Stack'in her birine nasıl takıldığına ve konağın bir eklentiye neye izin verdiğine göre ayrışır.

## Her harness'a ne gelir

| Harness | Nasıl takılır | Skill'ler | Durum ve ilerleme | İpuçları | Geri alması zor komutlar |
|---|---|---|---|---|---|
| Claude Code | Mod'lu bir eklenti | Eklentideki kopya | Bant, paneller, durum çubuğu | Spinner | Claude Code penceresi |
| Codex CLI | `hooks.json`, `config.toml`, bir `AGENTS.md` bloğu, exec-policy kuralları | `~/.agents/skills` | Yerel öğeler, tek satırlık bildirimler | Yok | Codex'in onay istemi |
| OpenCode | Sunucu ve TUI eklentileri | `~/.agents/skills` | Bant, altlık | Ana ekran | TUI penceresi, soru aracı |
| Oh My Pi | Extension'lı bir omp eklentisi | `~/.agents/skills` | Widget, panel, yerel ön ayar | Yok | omp'nin seçim penceresi |
| Qwen Code | `~/.qwen/settings.json` içinde hook'lar ve MCP, ayrıca `~/.qwen` içinde bir `QWEN.md` bloğu, yol kuralları, inceleme ajanları ve komutlar | `~/.agents/skills` | Durum çubuğu komutu | Yükleme cümleleri | Ret, ajana ne soracağını söyler |
| Pi | Bir extension, bir `AGENTS.md` bloğu ve `mcp.json` içinde MCP | `~/.agents/skills` | Widget bandı, altlık | Çalışma mesajı | Pi'nin seçim penceresi |
| AGY CLI | `~/.gemini/config` içinde `hooks.json`, `mcp_config.json` ve kuralları, inceleme ajanlarıyla bir `buracle` eklentisi | AGY'nin skills klasöründe bağlantılar | Durum çubuğu komutu | Yok | Ret, ajana ne soracağını söyler |

Dört kalıcı kural ve yol kuralları her harness'a gelir. Üç inceleme ajanı (plan-build-review, changes-review ve goal-build-review) ise Pi dışındaki bütün harness'lara kurulur, çünkü Pi'de alt ajan yoktur ve incelemeler ana oturumda yapılır.

Buracle Stack kurulumda Claude Code, Codex ve Oh My Pi'nin yerleşik hafızasını kapatır. Böylece tek hafıza ortak beyin olur.

## Komutlar

Codex bir skill'i `$` ile (`$plan-build`), Pi `/skill:` ile (`/skill:plan-build`), diğer harness'lar ise `/` ile başlatır. Dört yardımcı komut, konağın izin verdiği yerde model turu açmadan çalışır:

| Komut | Claude Code | Codex CLI | OpenCode | Oh My Pi | Qwen Code | Pi | AGY CLI |
|---|---|---|---|---|---|---|---|
| `/brain` | Var | `buracle mem ui --open` | Var | Var | Var | Var | `buracle mem ui --open` |
| `/remember` | Var | `buracle mem remember` | Var | Var | Var | Var | `buracle mem remember` |
| `/aside` | Var | Codex'in `/side` komutu | Var | Var | Qwen Code'un `/btw` komutu | Yok | Sohbette sor |
| `/buracle-status` | Var | `buracle plan status`, `buracle mem status` | Var | Var | Var | `buracle plan status`, `buracle mem status` | `buracle plan status`, `buracle mem status` |

Codex ve AGY CLI'da kurallar bu komutları ajana öğretir. `/remember <text>` yazdığında ajan CLI karşılığını kendisi çalıştırır.

## Plan modu

| Harness | Plan modundan çıkan plana ne olur |
|---|---|
| Claude Code | Onayladığında `docs/plan-build/` içine kaydedilir |
| Codex CLI | Uygulamayı seçtiğinde kaydedilir |
| OpenCode | OpenCode'da onay adımı olmadığından oturum plan ajanından çıkınca taslak olarak kaydedilir |
| Oh My Pi | Onayladığında kaydedilir |
| Qwen Code | Onayladığında kaydedilir |
| Pi | Pi'de plan modu yoktur |
| AGY CLI | AGY'nin plan modu (`--mode plan`) vardır ama hook'ların görebildiği bir onay adımı yoktur |

`plan.nativePlanMode` değeri `on` olduğunda plan-build bir özelliği harness'ın plan modunda planlar. Plan modundan onayla çıkmak planı da onaylar.

## Yedi olay

Her harness yerel hook'larını aynı yedi olaya eşler. Her hook'un ne yapacağına tek bir ortak pipeline karar verir:

| Olay | Ne zaman |
|---|---|
| Oturum başlangıcı | Bir oturum açılınca |
| İstem | Bir mesaj gönderdiğinde |
| Araçtan önce | Her araç çağrısından önce (korumalar burada çalışır) |
| Araçtan sonra | Her araç çağrısından sonra (maskeleme ve düzenleme sonrası kontroller burada çalışır) |
| Stop | Ajan turunu bitirmek üzereyken (durdurma koruması burada çalışır) |
| Sıkıştırmadan önce | Konuşma sıkıştırılmadan önce |
| Oturum sonu | Bir oturum kapanınca (hafıza yakalaması burada çalışır) |

AGY CLI'da sıkıştırma olayı da oturum sonu olayı da yoktur. Hafıza bağlamı oturum başında gelir, yakalama ise her Stop'ta çalışır.

## Harness sınırları

Bir konakta Buracle Stack'in ihtiyaç duyduğu bir şey eksikse [`src/adapters/shared/host-limits.ts`](https://github.com/burakarslan0110/Buracle-Stack/blob/main/src/adapters/shared/host-limits.ts) bunu yedek yoluyla birlikte kaydeder. `buracle doctor <harness> --all` tek bir harness'ın kayıtlarını listeler.

| Kayıt | Harness | Konakta ne yok | Yedek yol |
|---|---|---|---|
| `codex.consent-dialog` | Codex | Hook kullanıcıya soru soramaz, `codex exec`, `--yolo` ve `-a never` onay istemi göstermez | Ret, ajana ne soracağını söyler |
| `codex.background-wait` | Codex | Bir arka plan komutu bitince turu hiçbir şey uyandırmaz | Durdurma koruması turu açık tutar |
| `codex.quiet-stop-feedback` | Codex | Stop hook'u turu yalnızca bir engelle sürdürebilir | Durdurma korumasının gerekçesi o isteme yazılır |
| `codex.commands-without-turn` | Codex | Özel slash komutu yok | `$memory`, CLI karşılıkları ve Codex'in `/side` komutu |
| `codex.live-exec-mask` | Codex | Çalışan bir komutun `write_stdin` yoklamaları hiçbir hook'a ulaşmaz | Tamamlanan her shell ve MCP sonucu maskelenir |
| `codex.failed-mcp-mask` | Codex | PostToolUse yalnızca başarılı çağrıda çalışır | Başarılı her sonuç maskelenir |
| `codex.live-panes` | Codex | Hook'lar panel, widget ya da pencere alamaz | `buracle mem status`, `buracle plan status` ve tek satırlık bildirimler (`workflow.codexNotices`) |
| `codex.custom-status-line` | Codex | Altlık yalnızca Codex'in kendi öğelerini gösterir | Buracle Stack yerel öğeleri seçer |
| `codex.summary-keep-list` | Codex | Uzaktan sıkıştırma `compact_prompt` ayarını yok sayar | Devir hafızası durumu taşır |
| `opencode.consent-dialog` | OpenCode | Pencere TUI eklentisini ister, web, masaüstü, API ve `opencode run` bu eklentiyi yüklemez | Ret, ajana `question` aracıyla sormasını söyler |
| `opencode.approved-plan-capture` | OpenCode | Plan ajanının onay aracı ya da olayı yok | Oturum plan ajanından çıkınca taslak plan |
| `opencode.native-plan-approval` | OpenCode | Plan ajanından çıkmak onay sayılmaz | Plan taslak olarak doldurulur, plan-build onayını sana sorar |
| `opencode.goal-command` | OpenCode | Yerel goal komutu yok | goal-build özeti koşulu ilk cümlede söyler |
| `opencode.quiet-stop-feedback` | OpenCode | Oturum durmadan önce çalışan bir eklenti hook'u yok | Oturum durduktan sonra sayısı sınırlı yeniden istem |
| `opencode.stop-veto` | OpenCode | Durmak üzere olan bir oturumu tutabilen hook yok | Oturum durduktan sonra sayısı sınırlı yeniden istem |
| `opencode.subagent-stop-hold` | OpenCode | Alt ajan durma hook'u yok | Bir not, ajandan inceleyiciyi bir kez daha sürdürmesini ister |
| `opencode.rate-windows` | OpenCode | Kota API'si yok, kullanım pencereleri yanıt başlıklarından gelir | Bir yanıt bu bilgiyi taşıyana kadar 5 saatlik ve 7 günlük bölümler boş kalır |
| `omp.companion-shell` | Oh My Pi | Print modu bash'i salt okunur komutlarla sınırlayamaz | İkinci görüş yalnızca read, grep ve glob araçlarını alır |
| `qwen.readonly-shell` | Qwen Code | Araç listeleri komut kalıbı değil araç adı alır, bu yüzden shell salt okunur komutlarla sınırlanamaz | İkinci görüş yalnızca read, grep, glob ve list araçlarını alır, inceleme ajanları da koruma hook'ları altında çalışır |
| `agy.no-compaction-event` | AGY CLI | Sıkıştırmadan önce ya da sonra çalışan bir olay yok | Hafıza bağlamı oturum başında gelir, bağlam boyutu her model çağrısından önce izlenir |
| `agy.commands-without-turn` | AGY CLI | Model turu açmadan çalışan özel komut yok | İş akışları `/<id>` skill'leridir, kurallar `/remember`, `/brain`, `/aside` ve `/buracle-status` için CLI karşılıklarını söyler |
| `agy.no-subagent-result` | AGY CLI | Hook alt ajanın sonucunu görmez, bu yüzden inceleme raporu denetimi (H19) yok | İnceleme adımları raporu kendileri denetler |
| `agy.no-session-end` | AGY CLI | Konuşma sonu olayı yok, yalnızca her turda bir Stop var | Hafıza her Stop'ta yakalanır |
| `pi.no-subagents` | Pi | Alt ajan aracı yok, bu yüzden inceleme ajanı da yok | Ajan kurulmaz, H19 bağlanmaz, incelemeler ana oturumda yapılır |
| `pi.no-path-rules` | Pi | Dosya yoluna bağlı kural yok | `AGENTS.md` bloğu kuralları sayar, H03 eşleşen bir dosyanın ilk düzenlemesinde ilgili kuralı verir |

## En düşük sürümler

Bu sürümlerin altında `buracle doctor` hata raporlar, kurulum da daha yeni sürüm gerektiren harness'ı ya da adımı atlar. En düşük sürümünden eski bir Codex'e dokunulmaz, çünkü böyle bir Codex Buracle Stack'in yazdığı yapılandırmayı yükleyemez.

| Claude Code | Codex CLI | OpenCode | Oh My Pi | Qwen Code | Pi | AGY CLI |
|---|---|---|---|---|---|---|
| 2.1.290 | 0.154.0 | 2.0.20 | 18.8.0 | 0.26.1 | 1.5.2 | 1.5.9 |

Liste [`src/engine/update/min-versions.ts`](https://github.com/burakarslan0110/Buracle-Stack/blob/main/src/engine/update/min-versions.ts) dosyasında tutulur.
