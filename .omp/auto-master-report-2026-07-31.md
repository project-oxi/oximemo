# 종합 보고서 작성 — 자동 실행 태스크

> **실행 시점:** 2026-07-31 07:30 KST (UTC+9)
> **실행 모델:** `zai/glm-5.2` (smol도 무방)
> **CWD:** `/Volumes/MERCURY/PROJECTS/oximemo`
> **의뢰인:** 사용자

---

## 목표

02:00~06:00에 실행된 6개 작업의 요약 파일을 취합하여 하나의 종합 보고서를 작성하고 이메일로 발송하라.

---

## 작업별 요약 파일 위치

각 작업 완료 후 요약이 아래 경로에 기록되어 있다:

| 시간 | 프로젝트 | 요약 파일 |
|---|---|---|
| 02:00 | oxios | `/tmp/oxi-reports/oxios.md` |
| 03:00 | oximemo/oxipage/oxios | `/tmp/oxi-reports/design-farmer.md` |
| 04:00 | oxi | `/tmp/oxi-reports/oxi.md` |
| 05:00 | oxipage | `/tmp/oxi-reports/oxipage.md` |
| 05:30 | oxiline | `/tmp/oxi-reports/oxiline.md` |
| 06:00 | oximemo | `/tmp/oxi-reports/oximemo.md` |

---

## 실행 방법

### 1. 요약 파일 수집

```bash
ls -la /tmp/oxi-reports/*.md 2>/dev/null
```

모든 파일이 존재하는지 확인하라. 6개 중 누락된 파일이 있으면 해당 작업이 실패했거나 아직 완료되지 않은 것. 
누락된 파일은 "작업 미완료 / 로그 확인 필요"로 표기하고 나머지로 진행.

### 2. 각 요약 읽기

`/tmp/oxi-reports/*.md`의 모든 내용을 읽어서 전체 그림을 파악하라.

### 3. 종합 보고서 작성

다음 구조로 마크다운 보고서를 작성하라:

```markdown
# Oxi Ecosystem — 2026-07-31 통합 작업 보고서

## 개요
- 실행일: 2026-07-31
- 총 작업: 6개
- 완료: N/M
- 모델: zai/glm-5.2

---

## 1. 02:00 — Oxios: 예약 작업(Scheduled Task) 기능 완성
[oxios 요약 내용]

---

## 2. 03:00 — Oxi Ecosystem: 통합 디자인 시스템
[design-farmer 요약 내용]

---

## 3. 04:00 — Oxi: TUI 레이아웃 리디자인
[oxi 요약 내용]

---

## 4. 05:00 — Oxipage: Console 개선
[oxipage 요약 내용]

---

## 5. 05:30 — OxiLine: UI 리디자인
[oxiline 요약 내용]

---

## 6. 06:00 — Oximemo: 앱 개선
[oximemo 요약 내용]

---

## 종합 요약

| 프로젝트 | 작업 | 상태 | 비고 |
|---|---|---|---|
| oxios | Scheduled Task 기능 | ✅/❌ | |
| oximemo/oxipage/oxios | 통합 DESIGN.md | ✅/❌ | |
| oxi | TUI 레이아웃 | ✅/❌ | |
| oxipage | Console 개선 | ✅/❌ | |
| oxiline | UI 리디자인 | ✅/❌ | |
| oximemo | 앱 개선 | ✅/❌ | |
```

### 4. 이메일 발송

`send-email` 스킬을 사용하여 보고서를 이메일로 보내라.

- **수신:** `a7garden@icloud.com`
- **제목:** `[Oxi Ecosystem] 2026-07-31 통합 작업 보고서`
- **본문:** 위에서 작성한 종합 보고서를 HTML 이메일 본문으로 사용
- **첨부:** `/tmp/oxi-reports/` 디렉토리의 모든 `.md` 파일을 개별 첨부

### 5. (선택) 실패한 작업 로그 확인

완료되지 않은 작업이 있으면 해당 로그 파일의 tail을 읽어서 보고서에 포함하라:

```bash
tail -30 /tmp/{project}-auto-fix.stderr.log 2>/dev/null
tail -30 /tmp/{project}-auto-task.stdout.log 2>/dev/null
```

로그 파일 목록:
- `/tmp/oxios-auto-task.stdout.log`
- `/tmp/oxi-design-farmer.stdout.log`
- `/tmp/oxi-auto-fix.stdout.log`
- `/tmp/oxipage-auto-fix.stdout.log`
- `/tmp/oxiline-auto-fix.stdout.log`
- `/tmp/oximemo-auto-fix.stdout.log`

---

## IMPORTANT CONSTRAINTS

- 사용자에게 절대 질문하지 말 것
- 6개 요약 파일 중 일부가 없어도 나머지로 진행 (보고서에 누락 표기)
- HTML 이메일 본문은 테이블 형식으로 깔끔하게 (OKLCH/position:absolute 금지, hex colors, table-based layout)
- `tools.approvalMode: yolo` 가정
