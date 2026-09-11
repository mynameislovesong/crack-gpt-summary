# v1.2.14 구조 분석과 포팅 결과

첨부 ZIP의 manifest, 모든 실행 JS, 테스트, 변경 이력과 문서를 읽고 작업했습니다. 원본 파일은 수정하지 않았고 SHA-256 목록을 개발 패키지에 보관했습니다. 1.2.9 소스를 출발점으로 쓰지 않았습니다.

| 원본 파일/흐름 | userscript 구현 |
| --- | --- |
| manifest content_scripts 두 사이트 | 하나의 표준 메타데이터 + hostname별 초기화 |
| shared.js | URL/프롬프트/해시/timeout/상태 문자열 보존 |
| background.js의 START → UPLOAD → SEND → STATUS, 탭 query/create/update, scripting 주입 | 원본 Crack 탭의 `Bridge.send`, GM payload/inbox/state/lease, 수신 탭 ping, GM_openInTab. MV3 메시지 조각 전달과 worker 생명주기는 제거 |
| chrome.action 설정 열기 | 원본 ⚙ 버튼으로 모달 열기 유지 |
| chrome.storage.local 및 onChanged | GM 설정 객체, GM 변경 리스너, 같은 origin의 Web Locks로 설정 transaction 직렬화 |
| content/crack-message-api.js | 원본 endpoint·인증·pagination·검증·안전 한도·취소·reverse 보존. 공개 전역 export만 번들 내부 변수로 변경 |
| content/crack-log-extractor.js, ranges.js | 원본 정규화/논리 쌍/orphan/TXT/범위/hash 그대로 유지 |
| cleaner.js | 원본 여섯 옵션, 코드 fence 유지, 최종 TXT 단계에만 적용 |
| content/settings-modal.js | 원본 v1.2.14 CSS·UI·입력 보호 유지. 설정 요청은 로컬 도메인 함수 호출, 기록 변경 감지는 GM 리스너 |
| content/crack.js | 원본 launcher·드래그·진행 표시 유지. 수집 이후 Bridge.send 호출, worker keepalive/status polling 제거 |
| content/chatgpt.js | 원본 File/DataTransfer, input 후보, composer 파일명, ProseMirror 입력, enabled Send, 사용자 메시지 확인 유지. 등록/메시지 수신 부분을 Bridge.receive로 재설계 |
| content/route-state.js | 원본 Navigation.currententrychange/popstate/pageshow/hashchange 유지 |

`chrome` 가짜 객체나 확장 API shim은 없습니다. GM API는 탭 간 전달과 설정에 직접 사용하며 수집/DOM 조작과 분리했습니다. 실제 필요한 grant만 포함했습니다. 네이티브 fetch를 유지하므로 사용하지 않는 GM_xmlhttpRequest/@connect는 넣지 않았습니다.

## 동시 실행·취소

Crack origin의 source(chat+프리셋) 및 destination(URL) Web Locks를 보유한 작업만 전달합니다. 설정 transaction도 Web Locks로 여러 Crack 탭 사이에 직렬화합니다. ChatGPT origin에서는 대상 URL별 수신 잠금을 따로 사용합니다. **서로 다른 origin의 Web Locks가 공유된다고 가정하지 않습니다.** origin 사이의 연결은 GM 저장소로 수행합니다.

발신 측이 한 receiver ID를 선택하며 다른 탭은 payload를 처리하지 않습니다. 수신 측은 DOM 작업 전에 consumed 기록을 저장합니다. 재전달·재주입·수신 탭 새로고침 시 같은 작업을 자동 재전송하지 않습니다. ChatGPT의 새 사용자 메시지를 확인한 뒤 원본 탭이 아직 같은 채팅인지, 처리 기록 revision이 같은지 다시 확인하고 cursor를 씁니다.

lease는 실제 전송 중에만 5초 간격으로 갱신됩니다. GM 상태 변경은 리스너로 전달합니다. UI route polling은 없고 launcher 복구는 html의 직접 자식만 관찰합니다. 원본 API 수집 중 100ms 경로 검사와 ChatGPT DOM 대기 중 200ms 검사/observer는 작업 종료 시 해제합니다. ChatGPT에서도 route revision을 검사하므로 다른 채팅으로 갔다가 즉시 돌아와도 준비 중이던 작업은 취소됩니다.

## 요청한 16개 항목

아래 **정상은 실제 Chrome + 모의 GM 공유 저장소/API/ChatGPT 페이지를 이용한 자동 검사의 결과**입니다. 실제 Tampermonkey 및 로그인된 서비스에서의 확인과 혼동하지 않습니다.

| 번호 | 항목 | 결과 |
| --- | --- | --- |
| 1 | Tampermonkey 정상 설치 | 브라우저 실제 테스트 필요 — 표준 헤더/단일 번들 정적 검사 통과, 설치 UI 접근 불가 |
| 2 | Crack UI 표시 | 정상 — 원본 launcher·모달 표시 및 중복 주입 방지 |
| 3 | 현재 chatId 감지 | 정상 — A → B → A 경로 검증 |
| 4 | messages API 성공 | 정상 — 실제 수집 코드와 모의 API 검증. 실제 로그인/CORS는 브라우저 실제 테스트 필요 |
| 5 | 500개 초과 pagination | 정상 — 501/502/1,328개 입력 검증 |
| 6 | 시간순 정렬 | 정상 — 전체 reverse 및 TXT 내 순서 확인 |
| 7 | TXT 생성 | 정상 — 원본 내용·파일명·코드 경계 확인 |
| 8 | 설정 저장/재로드 | 정상 — 프리셋·옵션·기록·revision 검증 |
| 9 | ChatGPT URL 열기 | 정상 — GM_openInTab 호출과 새 페이지 연결 모의 검증 |
| 10 | ChatGPT 작업 수신 | 정상 — GM 전달 및 하나의 receiver 선택 |
| 11 | TXT 첨부 | 정상 — 실제 File/DataTransfer 및 DOM change 처리 |
| 12 | 프롬프트 입력 | 정상 — 실제 contenteditable 입력, 긴 지침 별도 TXT |
| 13 | 메시지 전송 | 정상 — enabled Send 한 번 클릭과 새 사용자 메시지 검증. 실제 서비스 전송은 브라우저 실제 테스트 필요 |
| 14 | 완료 결과 반영 | 정상 — 원본 Crack UI와 성공 후 cursor 저장 |
| 15 | 새로고침 후 설정 유지 | 정상 — GM 영속 저장 계약 및 새 문서에서 재조회. 실제 Tampermonkey 영속성은 브라우저 실제 테스트 필요 |
| 16 | 다중 탭 중복 방지 | 정상 — Crack 2개 + ChatGPT 2개에서 단일 전송 |

추가 검사: 파일명 누락, Send 비활성, 기존 초안, 확인 불확실, 401, 이동 중 취소, 원본 페이지 종료, 소비된 작업 재전달, launcher 복원, 기존 설정 false 값, 오래된 저장 revision, 초기화와 성공 기록의 경쟁, cursor 쓰기 직전 경로 변경.

## 배포와 한계

원본 확장 storage를 userscript에서 자동 열람할 수 없습니다. 프리셋과 기존 처리 위치 자동 이관은 수행하지 않습니다. 설치 전에 열린 ChatGPT 탭에 강제 주입하는 chrome.scripting에 대응하는 권한도 없으므로 최초 새로고침이 필요합니다. 기존 탭을 강제로 전면화하는 동작은 보장하지 않습니다. 이 차이를 숨기거나 기존 작성 중인 초안을 덮어쓰지 않습니다.

Tampermonkey API/메타데이터 기준: [공식 문서](https://www.tampermonkey.net/documentation.php).
