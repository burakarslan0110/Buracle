import { describe, expect, test } from 'bun:test'
import { memStem, memStemForms } from '../../../src/core/memory/stem'
import { normalizeForSearch } from '../../../src/core/memory/text'

const forms = (w: string): string[] => memStemForms(normalizeForSearch(w))

describe('memStemForms (query stemming, finding M3)', () => {
  test('Turkish plural, possessive and case endings come off', () => {
    expect(forms('hataları')).toEqual(['hata'])
    expect(forms('hatalar')).toEqual(['hata'])
    expect(forms('kodları')).toEqual(['kod'])
    expect(forms('testleri')).toEqual(['test'])
    expect(forms('yolları')).toEqual(['yol'])
    expect(forms('kararlarını')).toEqual(['karar'])
    expect(forms('hatasına')).toEqual(['hata'])
    expect(forms('hatanın')).toEqual(['hata'])
    expect(forms('kodundaki')).toEqual(['kod'])
    expect(forms('kodlarından')).toEqual(['kod'])
    expect(forms('sayfada')).toEqual(['sayfa'])
    expect(forms('testte')).toEqual(['test'])
    expect(forms('commitleri')).toEqual(['commit'])
    expect(forms('bağlantıları')).toEqual(['baglanti'])
    expect(forms('bağlantısında')).toEqual(['baglanti'])
  })

  test('a consonant a vowel ending softened is also offered hardened', () => {
    expect(forms('kitabı')).toEqual(['kitab', 'kitap'])
    expect(forms('köpeği')).toEqual(['kopeg', 'kopek'])
    expect(forms('kanadı')).toEqual(['kanad', 'kanat'])
    expect(forms('bilgi')).toEqual(['bilg'])
  })

  test('English plural, -ing and -ed come off', () => {
    expect(forms('tests')).toEqual(['test'])
    expect(forms('tokens')).toEqual(['token'])
    expect(forms('caching')).toEqual(['cach'])
    expect(forms('caches')).toEqual(['cach'])
    expect(forms('classes')).toEqual(['class'])
    expect(forms('policies')).toEqual(['polic'])
    expect(forms('running')).toEqual(['run'])
    expect(forms('stopped')).toEqual(['stop'])
    expect(forms('indexing')).toEqual(['index'])
  })

  test('words Turkish could not inflect that way, short stems and names stay whole', () => {
    for (const w of ['hata', 'kalite', 'chain', 'domain', 'table', 'update', 'delete', 'write', 'route', 'module', 'handler', 'login', 'plugin',
      'string', 'thing', 'using', 'speed', 'need', 'menu', 'emoji', 'status', 'analysis', 'garden', 'hafıza', 'güncelleme', 'near', 'fts5', 'max_tokens', 'db']) {
      expect([w, forms(w)]).toEqual([w, []])
    }
    expect(memStem('hata')).toBe('hata')
    expect(memStem('testleri')).toBe('test')
  })

  test('a stem keeps three letters and a vowel', () => {
    expect(forms('evleri')).toEqual(['evler'])
    expect(forms('ties')).toEqual([])
    for (const w of ['hataları', 'tokens', 'kitabından', 'yolları', 'caching']) {
      for (const s of forms(w)) {
        expect(s.length).toBeGreaterThanOrEqual(3)
        expect(s).toMatch(/[aeiou]/)
      }
    }
  })
})
