---
title: Konsol
description: Hafıza, plan incelemeleri ve iş akışı ayarları için yerel bir web sayfası olan Buracle Stack Konsolu.
order: 5
---

Buracle Stack Konsolu bilgisayarında, `http://localhost:41777` adresinde açılan bir web sayfasıdır. Hafızayı bir beyin olarak çizer ve iş akışı ayarlarını tutar. Planları ve değişiklikleri de burada incelersin. Arayüzü İngilizcedir.

## Açmak

- Bir harness'ta `/brain` çalıştır. Terminalde `buracle mem ui --open` çalıştır ya da `buracle` menüsünde Memory'yi seç.
- `/brain review` ya da `buracle mem ui --page review --open` inceleme sayfasını açar.

Konsol yalnızca 127.0.0.1 üzerinde dinler. 41777 portu doluysa bir sonraki boş portu kullanır. `buracle mem ui --port N` ile portu sen seçersin.

## Ne zaman çalışır

`memory.ui.autostart` açıkken (varsayılan) Konsolu kurulum ve her harness oturumu başlatır, en az bir oturum açık kaldıkça da Konsol çalışmayı sürdürür. Son oturum kapanınca ya da 2 saat boyunca etkinlik olmayınca yaklaşık bir dakika içinde durur.

| Amaç | Yapılacak |
|---|---|
| Bir sonraki oturuma kadar durdurmak | `buracle mem ui --stop` |
| Yalnızca elle başlatmak | `buracle config set memory.ui.autostart false` |
| Kendiliğinden hiç başlamamasını sağlamak | `BURACLE_NO_AUTOSTART=1` tanımla |
| Kullanılmayan Konsolun bekleme süresini değiştirmek | `BURACLE_UI_IDLE_MS` tanımla (milisaniye, varsayılan 30 dakika) |

`BURACLE_UI_IDLE_MS`, hiç harness oturumu görmemiş bir Konsol için geçerlidir. `buracle mem ui` ile elle başlattığın Konsol buna örnektir.

## Görünümler ve tuşlar

Ana görünüm bir projenin beynini ya da kişi beynini, hafıza türlerine karşılık gelen yedi bölgesiyle çizer. Beyinler arasında Brain seçicisiyle geçersin.

| Tuş | Görünüm |
|---|---|
| `/` | Arama: eşleşen hafızalar beyinde yanar |
| `1` ile `7` arası | Bir bölge ve hafızaları: Plans & decisions, Knowledge & ideas, Discoveries & references, You & preferences, Skills & procedures, Warnings & gotchas, Memories & events |
| `G` | Hafızaların birbirine nasıl bağlandığını gösteren ağ görünümü |
| `H` | Beyin sağlığı: beyin dosyası ve kovaları, CortexDB ile hafıza sunucusu, dosyalanmayı bekleyen yakalamalar, modelin kullanım payı, yedekler (Back up now düğmesiyle) ve bir projeyi beyinden kaldırma |
| `S` | Ayarlar |
| `T` | Açık ya da koyu tema |
| `Esc` | Açık paneli kapatır |

Bir hafızayı yönetmek için onu aç. Yaptığın düzenleme aynı hafızanın yeni bir sürümü olarak saklanır ve senin sözlerin sayılır. Retire hafızayı kullanımdan çıkarır ama saklar, Restore onu geri getirir, Delete ise kalıcı olarak siler.

## İnceleme sayfası

İnceleme sayfası kayıtlı projelerindeki planları, goal-build sözleşmelerini, PRD'leri ve dead-code denetimlerini listeler. Ajanın her checkout'ta ve worktree'de yaptığı değişiklikleri de gösterir. Onayını bekleyen plan işaretlenir.

1. Bir belge ya da checkout seç.
2. Belgede bir bölümü seç. Diff'te bir satır numarasına tıkla, bir aralık için ikinci satıra Shift ile tıkla.
3. Notunu yaz ve `Ctrl+Enter` ile kaydet.

Ajan senden onay istemeden ve bir değişikliği bitirmeden önce açık notların hepsini okur, uyguladığı her notu da işaretler. Adı gizli bilgi dosyasına benzeyen dosyalar gösterilmez.

## Ayarlar

`S` tuşuna bas. Workflow anahtarları plan-build, goal-build ve bugfix'in her harness'ta nasıl çalışacağını belirler. Yaptığın değişiklik hemen `~/.buracle/config.yaml` dosyasına yazılır, workflow'lar da onu ayarları bir sonraki okuyuşlarında uygular. Bir anahtarı `buracle config set <key> <value>` ile de değiştirebilirsin.

| Ayar | Anahtar | Varsayılan |
|---|---|---|
| Yapıma geçmeden önce plan için onayını iste | `plan.planApproval` | `true` |
| Doğrulanmış sonuç için onayını iste | `plan.resultApproval` | `true` |
| Kendi dalında, bir worktree'de yap | `plan.branchIsolation` | `true` |
| Planlarken açıklayıcı sorular sor | `plan.questions` | `true` |
| Planın bağımsız incelemesi | `plan.reviews.plan` | `true` |
| Değişikliklerin bağımsız incelemesi | `plan.reviews.changes` | `true` |
| Goal-build sözleşmesinin bağımsız incelemesi | `plan.reviews.goal` | `true` |
| Başka bir harness'tan ikinci görüş | `plan.reviews.companion` | `off` (ya da `auto`, `claude`, `codex`, `opencode`, `omp`, `qwen`, `pi`, `agy`) |
| Ölçütleri geçen bir goal-build'i doğrula | `plan.goalVerification` | `true` |
| Onaydan sonra model değiştirmek için dur | `plan.modelSwitch` | `off` (ya da `manual`) |
| Harness'ın yerleşik plan modunda planla | `plan.nativePlanMode` | `off` (ya da `on`) |

Onay, inceleme ve doğrulama anahtarlarını ajan değiştiremez. Çalışan bir goal-build sözleşmesini kilitlerken `plan.goalVerification` ve `plan.reviews.changes` değerlerini de kilitlediği için bu iki anahtarda yaptığın değişiklik ancak bir sonraki çalışmada geçerli olur.
