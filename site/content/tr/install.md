---
title: Kurulum
description: Neye ihtiyacın olduğu, tek kurulum komutu, komutun bilgisayarında neleri değiştirdiği ve hemen ardından yapman gerekenler.
order: 1
---

Tek komut Buracle Stack'i kurar ve bilgisayarında bulduğu her desteklenen harness'ı hazırlar:

```sh
curl -fsSL https://stack.buracle.dev/install.sh | bash
```

## Gereksinimler

- x64 ya da arm64 üzerinde macOS veya Linux. Windows ve WSL desteklenmez.
- En az bir harness: [Claude Code](https://code.claude.com/docs/en/quickstart), [Codex CLI](https://developers.openai.com/codex/cli), [OpenCode](https://opencode.ai), [Oh My Pi](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent), [Qwen Code](https://github.com/QwenLM/qwen-code), [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) ya da [AGY CLI](https://antigravity.google).
- git ve curl.
- Linux'ta ayrıca Bun yoksa unzip, Node.js yoksa libatomic1.

Buracle Stack, Bun 1.4 ya da daha yeni bir sürümle çalışır. Bun yoksa betik onu kendisi kurar. Betik hiçbir zaman sudo ya da paket yöneticisi çalıştırmaz. Eksik bir araç görünce durur ve onu kuracak komutu yazdırır: macOS'ta `xcode-select --install`, Linux'ta dağıtımının paket yöneticisine (apt-get, dnf, yum, pacman, apk ya da zypper) uygun satır.

## Betik ne yapar

1. git, curl ve Bun'ı kontrol eder, gerekirse Bun'ı kurar.
2. `main` dalını `~/buracle` içine klonlar. Bu klasörde bir checkout zaten varsa onu günceller.
3. Checkout içinde `bun install --frozen-lockfile` çalıştırır.
4. İşi `buracle install --script` komutuna devreder. Bu komut her bölüm için kısa bir özet yazdırır.

Çalıştırmadan önce [betiği](https://github.com/burakarslan0110/Buracle-Stack/blob/main/scripts/install.sh) okuyabilirsin. `BURACLE_CHECKOUT` checkout klasörünü, `BURACLE_HOME` ise `~/.buracle` klasörünü değiştirir.

## buracle install ne yapar

- Harness dosyalarını checkout'tan üretir ve dondurulmuş bir çalışma kopyasını `~/.buracle/runtime/<id>` içine alır. Kopya ancak bir sınamadan geçince devreye girer: Bir Claude Code hook'u ile bir Codex hook'u `rm -rf ~` komutunu reddetmeli, `ls` komutunu geçirmelidir.
- Araç zincirini `~/.buracle/toolchain` içine kurar: her MCP sunucusu paketini ve dil sunucusunu, eksik sistem araçlarını da Homebrew ile. Homebrew'un kuramadığı Node.js, uv, ripgrep ve jq için sabitlenmiş bir sürümü indirir, sabitlenmiş sha256 değeriyle doğrulayıp `~/.buracle/toolchain/system` içine açar.
- Her harness'ın yapılandırmasını ayrı bir transaction olarak yazar. Her transaction'ın yedeği, günlüğü ve sahiplik defteri vardır. Bir adım başarısız olursa yalnızca o harness geri alınır.
- `~/.buracle/config.yaml` dosyasını, `~/.buracle/brain` hafıza klasörünü ve `~/.local/bin` içindeki `buracle` komutunu oluşturur. Bu klasör PATH'te yoksa ekler.
- [Buracle Stack Konsolunu](console.md) başlatır ve `buracle doctor` kontrollerini çalıştırır.

Elle değiştirdiğin değerler olduğu gibi kalır, kurulum bunları çakışma olarak raporlar. Sildiğin öğeler silinmiş kalır. Çalışan bir harness'ın yapılandırmasını yazmak gibi nadir bir adımdan önce kurulum terminalde sana sorar. Sen evet demedikçe yanıt hayırdır.

## İlk adımlar

1. Açık her Claude Code oturumunda `/reload-plugins` çalıştır. Yeni oturumlar değişiklikleri kendiliğinden yükler.
2. Diğer harness'larda bir kez oturum aç: Codex için `codex login`, OpenCode için `opencode auth login`, Oh My Pi için `omp login`. Qwen Code, Pi ve AGY CLI'da da oturum açma adımlarını izle.
3. Kurulumun yazdırdığı sonraki adımları izle. Codex'te hook'ları `/hooks` ile bir kez onaylaman ya da kurulum sırasında açık kalan OpenCode pencerelerini ve omp oturumlarını yeniden başlatman istenebilir.
4. Her projede `buracle project sync` çalıştır. Komut bir `AGENTS.md` olup olmadığına bakar, `.agents/skills` klasörünü `.claude/skills` içine bağlar, yalnızca yerelde kalması gereken yolları `.git/info/exclude` ile git'in dışında tutar ve projenin beynini kurar.
5. Depoda henüz ajan yönergesi yoksa bir harness'ta `/project-rules` çalıştır. Bu komut koddaki gerçek komutları ve kuralları bulur, komutları çalıştırıp doğrular, ardından her harness'ın izlediği bir `AGENTS.md` yazar.

Codex skill'leri `$` ile, Pi ise `/skill:` ile başlatır. Son adım Codex'te `$project-rules`, Pi'de `/skill:project-rules` olur.

## Günlükler

| Günlük | Yol |
|---|---|
| Her kurulum çalıştırması | `~/.buracle/logs/install-<date>.log` (yalnızca senin kullanıcın okuyabilir) |
| Hook'lar ve CLI | `~/.buracle/logs/buracle.log` |

## Onarım

Kurulum komutunu yeniden çalıştır. Komut mevcut checkout'a `main` dalını çeker, `buracle install` de eksik ya da değişmiş olanı yerine koyar. Güncelleme çekmeden onarmak için yalnızca `buracle install`, tek bir harness'ı onarmak için `buracle install codex` çalıştır. Onarmadan önce neyin bozuk olduğunu görmek istersen `buracle doctor` çalıştır. Sağlık kontrolleri ve kaldırma için [Güncelleme ve onarım](update.md) sayfasına bak.
