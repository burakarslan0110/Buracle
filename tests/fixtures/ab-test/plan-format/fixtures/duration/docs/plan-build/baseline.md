---
created: 2026-11-05
status: APPROVED
approved: true
worktree: false
type: Feature
iterations: 0
---
# Süre metnini saniyeye çevir

## Hedef
"1h30m" gibi saat, dakika ve saniye birimlerinden oluşan bir süre metni toplam saniye sayısına çevrilir; tanınmayan bir metin hata verir.

## Bağlam
- Depo küçük bir Bun projesidir; testler `bun test` ile koşar, kaynak dosyalar `src/` altında, testler `tests/` altındadır.
- `tests/duration.test.ts` dosyası hazır ve şu an başarısız; `src/duration.ts` henüz yoktur.

## Kapsam
- İçinde: `src/duration.ts` dosyasının yazılması.
- Dışında: başka bir dosya, bağımlılık ya da yapılandırma değişikliği; test dosyasına dokunulmaz.

## Yaklaşım
Tek bir saf fonksiyon ya da sınıf; dış bağımlılık yok, girdi doğrulaması hata fırlatır.

```mermaid
flowchart LR
  A[girdi] --> B[dogrula] --> C[hesapla] --> D[sonuc]
```

## Tasks

### Task 1: Süre metnini saniyeye çevir

**Objective:** `export function parseDuration(text: string): number` içeren `src/duration.ts` dosyası yazılır ve mevcut test geçer.

**Files:**
- Create: `src/duration.ts`
- Test: `tests/duration.test.ts`

**Definition of Done:**
- `parseDuration("1h30m")` 5400, `parseDuration("45s")` 45, `parseDuration("2h")` 7200 ve `parseDuration("1h1m1s")` 3661 döndürür; birimler h, m ve s olup bu sırayla gelir ve her biri en fazla bir kez geçer.
- Boş metin, birimsiz bir sayı, bilinmeyen bir birim ya da birimsiz bir son parça için `Error("invalid duration")` fırlatılır.
- Test dosyası değiştirilmez; yalnızca `src/duration.ts` oluşturulur.
- Verify: `bun test tests/duration.test.ts`

- [ ] Task 1 done

## Riskler
- Yok.

## Varsayımlar
- Bun 1.4 ve TypeScript strict; test çalıştırıcısı `bun test`.
