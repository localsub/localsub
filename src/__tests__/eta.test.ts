import { describe, it, expect } from "vitest"
import { estimateRemaining, formatEta } from "@/lib/eta"

describe("estimateRemaining", () => {
  it("3개 미만 샘플이면 null", () => {
    expect(estimateRemaining([1000, 2000], 10)).toBeNull()
  })

  it("최근 간격 평균 × 남은 수", () => {
    // 1초 간격 4샘플, 남은 6개 → 6000ms
    expect(estimateRemaining([0, 1000, 2000, 3000], 6)).toBe(6000)
  })

  it("최근 20개만 사용한다", () => {
    const ts = Array.from({ length: 30 }, (_, i) => (i < 10 ? i * 10000 : 100000 + (i - 10) * 1000))
    const est = estimateRemaining(ts, 10)!
    expect(est).toBeLessThan(20000) // 느렸던 초기 10개에 끌려가지 않음
  })

  it("formatEta: i18n 키와 count를 반환한다", () => {
    expect(formatEta(30_000)).toEqual({ key: "dashboard.eta.lessThanMinute" })
    expect(formatEta(150_000)).toEqual({ key: "dashboard.eta.minutes", count: 3 }) // 올림
    expect(formatEta(3_900_000)).toEqual({ key: "dashboard.eta.hoursMinutes", count: 1, minutes: 5 })
  })

  it("formatEta: 분 반올림이 60이 되면 시간으로 이월한다", () => {
    // 1시간 59분 45초 → 분 반올림 60 → 2시간 0분
    expect(formatEta(7_185_000)).toEqual({ key: "dashboard.eta.hoursMinutes", count: 2, minutes: 0 })
  })
})
