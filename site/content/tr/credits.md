---
title: Açık kaynak
description: Buracle Stack'in kurduğu, bağlandığı ya da dayandığı açık kaynak projeler, harness'lar ve servisler, her birinin burada ne işe yaradığı ve lisansıyla.
order: 11
---

Buracle Stack MIT lisanslıdır ve aşağıdaki projelere dayanır. Her projenin lisansı ayrıdır. Kurulum, kurduğu projeleri her birinin yayımlandığı yerden indirir. Proje adları, logolar ve markalar sahiplerine aittir. Projelerin emeğini teslim etmek ve Buracle Stack'in birlikte çalıştığı ürünleri belirtmek için burada yer alırlar.

## MCP sunucuları

| Proje | Nedir | Buracle Stack nasıl kullanır | Lisans |
|---|---|---|---|
| [Context7](https://github.com/upstash/context7) | Upstash'in güncel kütüphane belgeleri servisi | `context7` sunucusu (`@upstash/context7-mcp`): kullandığın sürümün kütüphane ve framework belgeleri | MIT |
| [CodeGraph](https://github.com/colbymchenry/codegraph) | Ajanların MCP üzerinden sorguladığı, önceden indekslenmiş yerel bir kod grafiği | `codegraph` sunucusu ve indeks oluşturucu: semboller, çağıranlar, çağrılanlar ve etki | MIT |
| [Semble](https://github.com/MinishLab/semble) | Ajanlar için CPU'da çalışan anlamsal kod araması | `semble` sunucusu ve indeks oluşturucu: kodu amacına göre arama | MIT |
| [Open-WebSearch](https://github.com/Aas-ee/open-webSearch) | API anahtarı istemeyen, çok motorlu bir web araması sunucusu | Varsayılan motoru DuckDuckGo olan `web-search` sunucusu | Apache-2.0 |
| [Fetcher MCP](https://github.com/jae-jae/fetcher-mcp) | Web sayfalarını başsız Chromium ile okuyan bir sunucu | `web-fetch` sunucusu: JavaScript'i çalıştırılmış sayfalar Markdown, HTML ya da metin olarak | MIT (npm manifesti ISC diyor) |
| [grep.app](https://grep.app) | Vercel'in açık GitHub depolarında kod araması | `https://mcp.grep.app` uzak adresi üzerinden `grep` sunucusu | Barındırılan servis |
| [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) | Kodlama ajanlarına canlı bir Chrome tarayıcısı | Yalıtılmış profille ve kullanım istatistiği göndermeden çalışan `chrome-devtools` sunucusu | Apache-2.0 |

## Hafıza

| Proje | Nedir | Buracle Stack nasıl kullanır | Lisans |
|---|---|---|---|
| [CortexDB](https://github.com/liliang-cn/cortexdb) | Bilgi grafiğini tek bir SQLite dosyasında tutan, yerelde çalışan ajan hafızası | Ortak hafızanın motoru. Her proje için bir kova ve senin için bir kova tutan tek `brain.db`, her harness'a `buracle-memory` ile sunulur | MIT |

## Dil sunucuları

| Proje | Nedir | Buracle Stack nasıl kullanır | Lisans |
|---|---|---|---|
| [Pyright](https://github.com/microsoft/pyright) | Microsoft'un Python için tip denetleyicisi ve dil sunucusu | Python tanıları ve kod içinde gezinme | MIT |
| [typescript-language-server](https://github.com/typescript-language-server/typescript-language-server) | tsserver'ı saran, TypeScript ve JavaScript için bir dil sunucusu | TypeScript 6 ile birlikte kurulur, TypeScript ve JavaScript tanıları ve gezinme | Apache-2.0 |
| [gopls](https://github.com/golang/tools) | Go'nun resmî dil sunucusu | Go kuruluysa Go tanıları ve gezinme | BSD-3-Clause |
| [rust-analyzer](https://github.com/rust-lang/rust-analyzer) | Editörler için Rust derleyici ön yüzü | Rust araç zinciri kuruluysa Rust tanıları ve gezinme | MIT OR Apache-2.0 |
| [csharp-ls](https://github.com/razzmatazz/csharp-language-server) | Roslyn tabanlı bir C# dil sunucusu | .NET SDK kuruluysa C# tanıları ve gezinme | MIT |
| [Eclipse JDT LS](https://github.com/eclipse-jdtls/eclipse.jdt.ls) | Eclipse tabanlı Java dil sunucusu | Java 21 ya da daha yenisiyle Java tanıları ve gezinme | EPL-2.0 |

Claude Code ve Oh My Pi bu sunucuları yerleşik LSP desteğiyle çalıştırır, Codex ve OpenCode ise onlara `lsp` köprüsü üzerinden ulaşır.

## Çalışma ortamları ve araçlar

| Proje | Nedir | Buracle Stack nasıl kullanır | Lisans |
|---|---|---|---|
| [Bun](https://github.com/oven-sh/bun) | JavaScript çalışma ortamı, paketleyici, test çalıştırıcı ve paket yöneticisi | Buracle Stack'in CLI'ını ve komut hook'larını çalıştırır | MIT |
| [Node.js](https://github.com/nodejs/node) | V8 üzerine kurulu bir JavaScript çalışma ortamı | npm MCP sunucularını ve dil sunucularını çalıştırır | MIT |
| [uv](https://github.com/astral-sh/uv) | Python paket ve proje yöneticisi | `semble` paketini Python 3.12 üzerine kurar | Apache-2.0 OR MIT |
| [Git](https://git-scm.com) | Dağıtık sürüm denetimi | Projeler, worktree'ler ve bir incelemenin okuduğu diff | GPL-2.0 |
| [Homebrew](https://github.com/Homebrew/brew) | macOS ve Linux için paket yöneticisi | Kuruluysa eksik sistem araçlarını onunla kurar | BSD-2-Clause |
| [ripgrep](https://github.com/BurntSushi/ripgrep) | `.gitignore` kurallarına uyan özyinelemeli regex araması | Ajanlar ve betikler için tam metin araması (`rg`) | Unlicense OR MIT |
| [ast-grep](https://github.com/ast-grep/ast-grep) | Yapısal kod araması, lint ve yeniden yazma | Sözdizimini bilen arama ve yeniden yazma | MIT |
| [jq](https://github.com/jqlang/jq) | Komut satırı JSON işleyicisi | Skill'lerde ve betiklerde JSON işleme | MIT |
| [GitHub CLI](https://github.com/cli/cli) | GitHub'ın komut satırı aracı | Pull request'ler ve issue'lar (`gh`) | MIT |
| [tmux](https://github.com/tmux/tmux) | Terminal çoklayıcı | Codex ve OpenCode için ek bir durum satırı | ISC |
| [Ruff](https://github.com/astral-sh/ruff) | Python linter'ı ve biçimlendiricisi | Ruff yapılandıran projelerde Python düzenlemesinden sonraki kontrol | MIT |
| [ShellCheck](https://github.com/koalaman/shellcheck) | Shell betikleri için statik analiz | `.sh` ya da `.bash` dosyası düzenlendikten sonraki kontrol | GPL-3.0 |
| [golangci-lint](https://github.com/golangci/golangci-lint) | Birçok Go linter'ını çalıştıran araç | `.golangci` yapılandırması olan projelerde Go düzenlemesinden sonraki kontrol | GPL-3.0 |

Düzenleme sonrası kontroller ESLint, go vet, gofmt ve `dotnet format` da çalıştırır. Bunlar projeyle ya da dilin araç zinciriyle gelir, Buracle Stack onları kurmaz.

## Buracle Stack kodundaki kütüphaneler

| Proje | Nedir | Buracle Stack nasıl kullanır | Lisans |
|---|---|---|---|
| [beautiful-mermaid](https://github.com/lukilabs/beautiful-mermaid) | Mermaid diyagramlarını SVG olarak çizer | Konsol'un inceleme sayfasında planların ve PRD'lerin Mermaid bloklarını çizer | MIT |
| [elkjs](https://github.com/kieler/elkjs) | Otomatik grafik yerleşimi | Bu diyagramları yerleştirir (beautiful-mermaid'in bağımlılığı) | EPL-2.0 |
| [entities](https://github.com/fb55/entities) | HTML ve XML varlıklarını kodlama | beautiful-mermaid'in bağımlılığı | BSD-2-Clause |
| [jsonc-parser](https://github.com/microsoft/node-jsonc-parser) | Yorum içeren JSON için ayrıştırıcı | Harness ayar dosyalarını yerinde düzenler, yorumlarını ve düzenini korur | MIT |
| [yaml](https://github.com/eemeli/yaml) | YAML ayrıştırıcı ve yazıcı | `canonical/` klasörünü okur, `~/.buracle/config.yaml` dosyasını yorumlarını koruyarak yazar | ISC |
| [TypeScript](https://github.com/microsoft/TypeScript) | JavaScript'e derlenen tipli bir dil | Buracle Stack'in kendi kaynak kodunun tip denetimi | Apache-2.0 |

## Birlikte çalıştığı harness'lar

| Proje | Nedir | Buracle Stack nasıl bağlanır | Lisans |
|---|---|---|---|
| [Claude Code](https://github.com/anthropics/claude-code) | Anthropic'in terminal, IDE ve masaüstü için kodlama ajanı | Skill'ler, kurallar, ajanlar, MCP sunucuları, hook'lar ve durum satırı içeren bir eklenti | Tescilli |
| [Codex CLI](https://github.com/openai/codex) | OpenAI'ın terminalde çalışan kodlama ajanı | `hooks.json`, `config.toml`, bir `AGENTS.md` bloğu ve skill'ler | Apache-2.0 |
| [OpenCode](https://opencode.ai) | Birçok model sağlayıcısıyla çalışan açık kaynak bir terminal kodlama ajanı | Ortak hook hattını çalıştıran sunucu ve TUI eklentileri | MIT |
| [Oh My Pi](https://github.com/can1357/oh-my-pi) | Alt ajanları, plan modu ve LSP desteği olan bir terminal kodlama ajanı | Extension'lı bir omp eklentisi | MIT |
| [Qwen Code](https://github.com/QwenLM/qwen-code) | Qwen ekibinin terminal kodlama ajanı | Ayarlarında hook'lar ve MCP, bir `QWEN.md` bloğu, inceleme ajanları ve komutlar | Apache-2.0 |
| [Pi](https://github.com/earendil-works/pi) | Sade bir terminal kodlama ajanı | Bir extension, bir `AGENTS.md` bloğu ve `mcp.json` içinde MCP | MIT |
| [AGY CLI](https://antigravity.google) | Google Antigravity'nin terminal ajanı | `hooks.json`, `mcp_config.json` ve bir `buracle` eklentisi | Tescilli |

Her birinin ne aldığı [Harness'lar](harnesses.md) sayfasında.

## Servisler

| Servis | Nedir | Buracle Stack nasıl kullanır |
|---|---|---|
| [skills.sh](https://skills.sh) | Ajan skill'leri için açık bir kayıt defteri | `buracle skills find` buradaki adayları risk puanlarıyla listeler |
| [GitHub](https://github.com) | Kod barındırma | Buracle Stack'in deposu ve sürümleri, bir de `buracle skills find` komutunun gösterdiği lisans ve güncellik bilgisi |
