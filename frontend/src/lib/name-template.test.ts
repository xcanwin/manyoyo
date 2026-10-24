import { describe, expect, test } from "vitest"

import { expandTemplate, formatNow } from "./name-template"

describe("name-template", () => {
  test("{now} 是 年月日-时分秒", () => {
    expect(formatNow(new Date(2026, 9, 24, 23, 9, 5))).toBe("20261024-230905")
  })

  test("展开 {now}、${now}、{quickChatPath}，并标出是否按模板生成", () => {
    const vars = { now: "20261024-230905", quickChatPath: "/root/manyoyo_work/" }
    expect(expandTemplate("my-easy-{now}", vars)).toEqual({ value: "my-easy-20261024-230905", templated: true })
    expect(expandTemplate("x-${now}", vars).value).toBe("x-20261024-230905")
    expect(expandTemplate("{quickChatPath}/{now}", vars).value).toBe("/root/manyoyo_work/20261024-230905")
    expect(expandTemplate("/srv/mine", vars)).toEqual({ value: "/srv/mine", templated: false })
  })
})
