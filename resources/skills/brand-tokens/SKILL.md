---
name: brand-tokens
description: >-
  EasyMint 内置品牌设计库（Airbnb、Stripe、Apple、Linear、Notion、Figma 等几十个主流品牌）：
  每个品牌的设计 token（配色 / 字体 / 圆角）与视觉语言说明。用户指定或提到某个品牌的风格、
  需要按其配色与排版做界面时使用。品牌清单见 ./brands.md，单个品牌规范见
  ./brands/<品牌>/DESIGN.md。
---

# 品牌库

品牌规范按品牌名分目录存放。以下路径**相对本 SKILL.md 所在目录**（= `available_skills` 里
本条目 `<location>` 去掉末尾 `/SKILL.md`），使用时解析成绝对路径：

```
./brands.md                  品牌清单（品牌名 + 一句话风格描述）
./brands/<品牌>/DESIGN.md     该品牌的完整 token 与视觉语言
```

## 怎么用

1. **任务已给品牌名** → 直接 Read `<技能目录>/brands/<品牌>/DESIGN.md`，一次只读这一个。
2. **不知道有哪些品牌** → 先 Read `<技能目录>/brands.md`，从清单里挑一个，再按上一步 Read。
3. **品牌名不在清单里** → 回退到设计规范里的通用色系，不要编造品牌 token。

## 不要做

- 不要 ls / find / glob 遍历 `brands/` 挑品牌——几十个品牌，翻起来就是灾难。
- 不要一次读多个品牌的 DESIGN.md 做对比，也不要复制品牌文件进项目。
