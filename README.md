# Crack GPT 로그 요약 — Tampermonkey

Chrome 확장 **v1.2.14**를 기준으로 포팅한 단일 userscript입니다. 버전은 **1.2.14.2**입니다.

## 설치

1. Tampermonkey를 설치하고 브라우저에서 userscript 실행을 허용합니다.
2. **[단일 userscript 설치](https://raw.githubusercontent.com/mynameislovesong/crack-gpt-summary/main/crack-gpt-summary.user.js)**를 열어 설치합니다.
3. 기존 Crack GPT 요약 확장프로그램은 꺼 주세요. 두 버전을 동시에 실행하지 않습니다.
4. 이미 열려 있던 Crack과 ChatGPT 페이지는 처음 한 번 새로고침합니다.
5. Crack의 ⚙ 설정에서 지침 프리셋과 `https://chatgpt.com/c/…` 대화 URL을 저장하고 요약 버튼을 누릅니다.

Raw 파일 하나에 모든 코드가 포함되어 있으며 `@require`가 없습니다. 설치 주소와 업데이트 주소 모두 이 저장소의 main 브랜치를 사용합니다.

## 보존한 동작

- 현재 Crack 채팅의 API 메시지 전체 수집, 500개 cursor pagination, 중복 제거 및 시간순 정렬.
- v1.2.14의 과거 메시지 `chatId` 메타데이터 허용 수정.
- 논리 T 번호, 짝 없는 메시지 보존, 전체/마지막 처리 이후/직접 지정 범위 및 성공 후에만 처리 위치 기록.
- 프리셋별 지침/ChatGPT URL, 설정 모달, 드래그 위치 저장, 모달 붙여넣기와 Enter 처리.
- 출력 TXT에만 적용하는 여섯 정리 옵션. 코드블록 삭제 옵션은 없고 fence는 유지.
- TXT 파일명 확인 → 요약 지침 입력 → 활성 Send 대기 → 한 번 클릭 → 실제 사용자 메시지 확인.
- 6,000자를 초과하는 지침은 `Crack-GPT-Instructions.txt`로 별도 첨부.
- 진행 상태, 시간 측정, 취소, 전송 불확실 시 재시도 금지 및 처리 기록 보호.

## Tampermonkey에서 달라지는 점

확장프로그램의 storage는 Tampermonkey 저장소와 분리되어 있어 **기존 확장의 프리셋과 처리 기록은 자동으로 읽을 수 없습니다.** 최초 설정은 다시 입력하고 전송 시작 범위를 확인해야 합니다. userscript 안에서 저장한 설정과 기록은 이후 새로고침에도 유지됩니다.

userscript가 실행 중인 ChatGPT 탭에는 GM 저장소를 통해 연결을 확인하고 그중 하나만 선택합니다. 연결 가능한 탭이 없으면 `GM_openInTab`으로 지정 URL을 엽니다. userscript가 설치되기 전에 열린 탭에는 확장 방식의 강제 스크립트 주입을 할 수 없어 최초 새로고침이 필요합니다. 기존 탭의 강제 활성화는 브라우저 정책상 보장하지 않습니다. 입력 검증이 실패하면 해당 탭을 전면에 열어 상태를 확인하세요.

Crack 원본 탭이 중앙 제어를 맡습니다. 작업 중 탭을 닫거나 채팅을 이동하면 취소합니다. 원본 탭이 비정상 종료되어 취소 이벤트를 보내지 못해도 30초 lease가 만료되면 수신 측은 전송을 중단합니다. 백그라운드 worker는 없습니다.

API는 원본과 동일한 Crack 페이지 `fetch` 및 현재 access cookie를 사용합니다. OpenAI API는 사용하지 않습니다. CORS/인증 실패를 우회하거나 DOM 로그 수집으로 대체하지 않습니다.

## 데이터

설정과 기록은 userscript 전용 `cg-settings`, 드래그 위치는 `crackGptLauncherPosition`에 저장합니다. RP 로그와 지침은 탭 간 전달을 위해 GM 저장소에 잠깐 기록되며 수신 즉시 제거합니다. 실패 시 발신 측도 제거합니다. 양쪽 탭의 강제 종료로 남은 만료 데이터는 다음 userscript 실행 시 정리합니다. 임시 작업 만료는 6분이며 만료 작업을 재전송하지 않습니다. 토큰과 RP 본문은 콘솔에 출력하지 않습니다.

## 검증 범위

실제 Chrome DOM을 사용하는 자동 검사에서 공유 GM API 동작을 모의 구현해 검증했습니다. **실제 Tampermonkey 설치와 로그인된 Crack → ChatGPT 종단 간 전송은 아직 검증하지 않았습니다.** 브라우저 도구가 Chrome 내부 확장 관리 탭에 접근할 수 없어 설치 확인을 완료하지 못했습니다.

원본 분석, 16개 요청 항목별 결과와 한계는 [PORTING.md](PORTING.md), 개별 자동 검사 결과는 [TEST-RESULTS.txt](TEST-RESULTS.txt)에 있습니다.

개발용 소스와 검사는 별도 로컬 개발 패키지에 포함됩니다. `node build.cjs`로 단일 파일을 재생성합니다. Playwright 설치 후 `npm test`로 검사를 실행하며 설치된 Chrome은 `CHROME_EXECUTABLE` 환경변수로 지정할 수 있습니다.
