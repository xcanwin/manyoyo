import { describe, expect, test } from "vitest"

import { imageNameOptions, versionAfterNameChange, versionsOf, type LocalImage } from "@/lib/image-options"

const img = (name: string, tag: string): LocalImage => ({ name, tag, id: "x", created: "", size: "" })
const images = [img("ghcr.io/xcanwin/manyoyo", "2.3.0-common"), img("ghcr.io/xcanwin/manyoyo", "2.2.0-common"), img("my/sandbox", "1.0.0-full")]

describe("image-options", () => {
  test("镜像名候选：本机有的、默认的、配置里现在的，去重", () => {
    expect(imageNameOptions(images, "ghcr.io/xcanwin/manyoyo", "other/img")).toEqual(["ghcr.io/xcanwin/manyoyo", "my/sandbox", "other/img"])
    expect(imageNameOptions([], "d", "")).toEqual(["d"])
  })

  test("某个镜像的版本；名字留空按默认镜像名", () => {
    expect(versionsOf(images, "my/sandbox", "d").map((i) => i.tag)).toEqual(["1.0.0-full"])
    expect(versionsOf(images, "", "ghcr.io/xcanwin/manyoyo").map((i) => i.tag)).toEqual(["2.3.0-common", "2.2.0-common"])
    expect(versionsOf(images, "nope", "d")).toEqual([])
  })

  test("改镜像名后版本联动：不属于新镜像就换成它最新的，已属于就不动，本机没有的名字不动", () => {
    expect(versionAfterNameChange(images, "my/sandbox", "2.3.0-common")).toBe("1.0.0-full")
    expect(versionAfterNameChange(images, "my/sandbox", "")).toBe("1.0.0-full")
    expect(versionAfterNameChange(images, "ghcr.io/xcanwin/manyoyo", "2.2.0-common")).toBeUndefined()
    expect(versionAfterNameChange(images, "not/pulled", "2.2.0-common")).toBeUndefined()
    expect(versionAfterNameChange(images, "", "2.2.0-common")).toBeUndefined()
  })
})
