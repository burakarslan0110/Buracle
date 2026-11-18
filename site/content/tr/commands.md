---
title: Komutlar
description: Ne zaman gerektiğine göre gruplanmış buracle komutları, her biri tek satırlık bir örnek ve sonucuyla.
order: 9
---

Terminalde `buracle` çalıştırınca bir menü açılır: Install or repair (`i`), Update (`u`), Health check (`d`), Memory (`m`, Konsolu açar) ve Quit (`q`). Aşağıdaki komutları sen çalıştırırsın ve hepsi ne zaman gerektiğine göre gruplanmıştır. Her komut `--json` ve `--help` alır, `buracle help <command>` de tek bir komutu açıklar. Harness içinde başlattığın `/plan-build` gibi skill'ler [Kullanım senaryoları](flows.md) sayfasında.

## İlk kurulum

| Örnek | Sonuç |
|---|---|
| `buracle install` | Bulduğu her harness'ı kurar ya da onarır, her bölüm için bir özet yazdırır |
| `buracle install --dry-run` | Her değişikliğin diff'ini gösterir, hiçbir şey yazmaz |
| `buracle install codex opencode` | Yalnızca Codex ile OpenCode'u kurar ya da onarır |
| `buracle project sync` | Bir depoda `AGENTS.md` var mı diye bakar, `.agents/skills` klasörünü `.claude/skills` içine bağlar ve projenin beynini kurar |
| `buracle doctor` | Her parçayı denetler, yalnızca sorunları çözümleriyle birlikte listeler |

Terminal olmadan `buracle install` yalnızca `--yes` ile uygular. Kurulum betiği ve ilk adımlar [Kurulum](install.md) sayfasında. `context7` için API anahtarı vermek istersen aşağıdaki [MCP sunucuları](#mcp-sunucuları) bölümüne bak.

## Her gün

| Örnek | Sonuç |
|---|---|
| `buracle config get plan` | İş akışı anahtarlarını varsayılanlar dâhil geçerli değerleriyle yazdırır |
| `buracle config set plan.reviews.companion auto` | Başka bir harness'tan ikinci görüş almayı açar |
| `buracle config unset plan.reviews.companion` | Varsayılan değere döner |
| `buracle mem ui --open` | [Buracle Stack Konsolu'nu](console.md) tarayıcında açar |
| `buracle usage` | Her harness'ın bildirdiği 5 saatlik ve 7 günlük kullanım pencerelerini sıfırlanma zamanlarıyla gösterir |
| `buracle update --check` | Her parçayı en yeni sürümüyle karşılaştırır. Bekleyen güncelleme sayısını durum satırı gösterir |
| `buracle update` | Yenilikleri adım adım uygular, Buracle Stack'in kendisi değiştiyse yeniden kurar |

`buracle config`, `~/.buracle/config.yaml` dosyasını okuyup yazar. Harness'ların ayar dosyalarına yazılan anahtarlar (`permissions.*`, `agents.teams`, `harnesses.*`, `routing.strictness`, `mcp.off.*`) harness'a bir sonraki `buracle install` ile ulaşır. Korumaları, onayları ve incelemeleri bir ajan değiştiremez, bu `config set` komutlarını kendin çalıştırırsın. Güncelleme türleri [Güncelleme ve onarım](update.md#güncelleme) sayfasında.

## Bir şeyler ters gittiğinde

| Örnek | Sonuç |
|---|---|
| `buracle doctor` | Her bölüm için bir satır, altında yalnızca uyarılar ve hatalar, her birinin çözümüyle |
| `buracle doctor codex` | Yapılandırmayı, çalışma kopyasını ve Codex'i denetler |
| `buracle doctor runtime` | Hook'ların çalıştırdığı dondurulmuş kopyayı, son 24 saatteki hook hatalarını ve eskimiş kilitleri denetler |
| `buracle doctor memory --all` | Geçenler dâhil bütün hafıza kontrollerini gösterir |
| `buracle install` | Yeni sürüm çekmeden eksik ya da değişmiş olanı geri yükler |
| `buracle install codex` | Yalnızca Codex'i onarır |
| `buracle uninstall --dry-run` | Kaldırmanın neleri sileceğini listeler, hiçbir şey yazmaz |

Çıkış kodu her komutta aynıdır: `0` başarı, `1` hata, `2` kısmi başarı ya da senin yapman gereken bir şey. Sık görülen sorunlar ve çözümleri [Güncelleme ve onarım](update.md#sık-görülen-sorunlar) sayfasında, kaldırmanın neleri bıraktığı da [Kaldırma](update.md#kaldırma) bölümünde.

## Hafıza

| Örnek | Sonuç |
|---|---|
| `buracle mem search "release process"` | Bu projenin ve senin hafızalarından eşleşenler |
| `buracle mem remember "we pin Bun in .bun-version"` | Daha sonra doğru türe dosyalanacak bir yakalama |
| `buracle mem status` | Kovalarıyla birlikte beyin dosyası, bölge başına sayılar, son yazma ve son yakalama |
| `buracle mem capture` | Bu projenin en yeni oturumu için oturum sonu yakalamasını hemen çalıştırır |
| `buracle mem backup` | Beyin dosyasının tamamını `~/.buracle/brain/backups/<id>/` içine kopyalar, en yeni 10 kopyayı tutar |
| `buracle mem restore <id> --project <slug>` | Bir yedekten tek bir projenin kovasını geri yükler, ötekilere dokunmaz |

Ajanların her hafıza aracının bir CLI ikizi var. Liste [Komut satırından hafıza](memory.md#komut-satırından-hafıza) bölümünde.

## MCP sunucuları

| Örnek | Sonuç |
|---|---|
| `buracle mcp list` | Her sunucu, her harness'taki durumu ve onu başlatan komut |
| `buracle mcp status` | Çalışan her Buracle Stack MCP süreci, rolü, oturumları, bellek kullanımı ve çalışma süresiyle |
| `buracle mcp disable chrome-devtools --harness codex` | Sunucuyu yalnızca Codex'te kapatır |
| `buracle mcp enable chrome-devtools --harness codex` | Sunucuyu yeniden açar |
| `buracle mcp stop` | Paylaşılan backend'leri hemen durdurur. Sonraki çağrı onları yeniden başlatır |
| `buracle mcp key` | Her API anahtarının nereden geldiğini gösterir |

Anahtar shell geçmişine düşmesin diye onu pipe ile aktar:

```sh
pbpaste | buracle mcp key context7
```

Linux'ta `pbpaste` yerine `wl-paste` ya da `xclip -o` kullan. Her sunucunun ne işe yaradığı [Araçlar](tools.md#sunucuları-yönetmek) sayfasında.

## Projeler ve skill'ler

| Örnek | Sonuç |
|---|---|
| `buracle project check` | Yol kurallarını, skill bağlantılarını ve `CLAUDE.md` dosyasını `AGENTS.md` ile karşılaştırıp kaymaları raporlar. Hiçbir şeyi değiştirmez |
| `buracle index status` | Projenin kod indekslerinin durumunu ve son hatayı gösterir |
| `buracle skills list` | Her skill ve kaynağı |
| `buracle skills find "terraform plan review"` | Eşleşen kurulu ve hazır gelen skill'ler, ardından lisans, güncellik ve risk puanlarıyla kayıt defterindeki adaylar |
| `buracle skills add owner/repo --dry-run` | Skill'in denetimi (betikler, shell pipe'ları, gizli bilgiler, enjeksiyon ifadeleri). Hiçbir şey kurulmaz |
| `buracle skills add owner/repo` | Skill'i `~/.agents/skills/<id>` içine kopyalayıp `~/.claude/skills/<id>` içine bağlar, böylece her harness onu okur |
| `buracle skills update` | Kurulu skill'leri yeniden çeker, kaynağında değişenleri yeniden kurar |
| `buracle skills remove <id>` | `add` ile kurulan bir skill'i kaldırır |

Harness içinde `/find-skill <need>` aynı aramayı, denetimi ve kurulumu senin yerine yapar.

## Ajanların kullandığı komutlar

Ajanların ve hook'ların kullandığı başka komutlar da var: `plan`, `flow`, `worktree`, `review-scope`, `rules`, `index`, `usage`, `hook`, `statusline`, `lsp` ve `consent`. Hepsini `buracle help --all` listeler. Bir çalışmanın durumuna kendin bakarken şunlar işine yarar:

| Örnek | Sonuç |
|---|---|
| `buracle plan audit` | Planda listelenen dosyaları diff ile karşılaştırır. Planlı bir iş eksikse ya da planlanmamış bir değişiklik varsa 2 koduyla çıkar |
| `buracle worktree status` | Deponun bütün plan worktree'leri |
| `buracle worktree diff saved-searches` | O worktree'nin dalındaki commit'ler, dosyalar ve istatistikler, temel dala göre |
| `buracle lsp check` | Her dil sunucusunu başlatıp el sıkışmasını çalıştırır |
