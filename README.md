# omo-jev-plugin

[Jev](https://docs.typesafe.ai/)의 구조화된 판단을 [OmO](https://www.npmjs.com/package/omo-ai) / senpi 에이전트에 연결하는 플러그인입니다. 작업 중 스킬과 다음 도구의 적합성을 평가하고, 반복이나 완료 가능성을 살펴 에이전트에 짧은 제안을 전달합니다. Jev가 도구를 직접 실행하거나 senpi의 권한 검사를 대신하지는 않습니다.

## 설치

OmO 또는 senpi에서 패키지를 설치합니다.

```sh
omo install npm:omo-jev-plugin
```

플러그인 로딩 시 npm에 새 버전이 있으면 설정 파일과 API 키를 확인하기 전에 UI로 업데이트를 안내합니다. `omo update npm:omo-jev-plugin`으로 업데이트할 수 있습니다. npm 조회가 실패해도 플러그인 시작은 계속됩니다.

Jev API 키는 `~/.omo/jev-plugin.jsonc`의 `apiKey` 또는 **OmO/senpi를 실행하는 프로세스의 환경 변수** `TYPESAFE_API_KEY`로 설정하세요. 설정 파일의 값이 우선하며, 없으면 환경 변수를 사용합니다. API 주소도 `endpoint`로 지정할 수 있습니다. 두 값은 프로젝트별 설정 파일에서도 지정할 수 있으므로 그 파일을 공유할 때 키가 포함되지 않도록 주의하세요. 키 발급과 API 사용법은 [TypeSafe 문서](https://docs.typesafe.ai/introduction/quickstart)를 참고하세요. 키가 어느 쪽에도 없으면 플러그인 로딩 직후 UI에 경고를 표시하고 Jev 판단을 실행하지 않습니다.

설치만으로 Jev API를 호출하지는 않습니다. 플러그인을 처음 로드할 때 기본 설정 파일이 자동 생성되며, Jev를 사용하려면 아래처럼 모드를 변경해야 합니다.

## 설정

처음 로드하면 `~/.omo/jev-plugin.jsonc`가 `off` 모드의 기본값으로 생성됩니다. 이미 파일이 있으면 덮어쓰지 않습니다. 파일에서 `mode`를 변경하거나 [`설정 예시`](./jev-plugin.example.jsonc)를 참고하세요. 이 파일은 OmO의 `omo.jsonc`와 별개입니다. 설정 변경 후에는 새 세션을 시작하거나 확장을 다시 로드하세요.

가장 간단한 설정은 다음과 같습니다.

```jsonc
{
  "mode": "advise",
  "apiKey": "your-typesafe-key",
  "endpoint": "https://api.typesafe.ai",
  "display": {
    "startup": true,
    "decisions": true
  },
  "decisions": {
    "skills": true,
    "nextAction": true,
    "loopDetection": true,
    "completion": true
  }
}
```

프로젝트별 설정은 해당 프로젝트의 `.omo/jev-plugin.jsonc`에 직접 넣을 수 있습니다. 프로젝트 파일은 자동 생성되지 않고, 프로젝트가 신뢰된 경우에만 읽으며 전역 설정을 덮어씁니다. `decisions`, `display`, `limits`, `thresholds`는 항목별로 병합되고 나머지 항목은 프로젝트 값으로 교체됩니다. 알 수 없는 설정 항목이나 잘못된 JSONC가 있으면 플러그인을 비활성화하고 경고를 표시합니다.

| 모드 | 동작 |
| --- | --- |
| `off` | Jev를 호출하지 않습니다. 기본값입니다. |
| `shadow` | 판단을 세션에 기록하지만 에이전트 동작은 바꾸지 않습니다. |
| `advise` | 판단 결과 중 스킬·도구 후보, 반복 및 완료 가능성을 에이전트에 제안합니다. |
| `act` | `advise`에 더해, 개별적으로 활성화한 도구 활성화·호출 차단·모델 및 사고 수준 선택을 적용합니다. |

`enabled: false`는 모드와 관계없이 플러그인의 판단을 끕니다. 에이전트가 명시적으로 호출한 스킬은 자동 스킬 제안보다 우선합니다. Jev가 적합한 후보를 찾지 못하거나 응답에 확신이 부족하면 후보를 제안하지 않습니다.

`display.startup`은 키와 설정을 정상 로드해 활성화했을 때 UI에 모드, 모델, API 주소, 키 출처(키 값 제외), 켜진 판단 항목과 호출 제한을 일회성 알림으로 보여줍니다. 기본값은 `true`입니다. `display.decisions`는 각 턴의 Jev 선택과 도구 호출 사전 검사 결과를 UI에 표시합니다. 알림이 잦을 수 있어 기본값은 `false`이며, `shadow` 모드에서도 판단 내용을 관찰할 수 있습니다. 두 옵션과 별개로 Jev가 활성화된 세션은 매 턴 종료 시 입력·출력 토큰과 예상 비용을 해당 턴 및 세션 누계로 UI 이력에 기록합니다. 이 기록은 모델 입력에 포함되지 않으며, 세션을 다시 열어도 누계를 이어갑니다. 키 누락·오류 경고는 표시 옵션과 관계없이 표시됩니다.

`shadow` 모드에서는 추천한 도구가 해당 턴에 실제로 실행되었는지, 실행되었다면 첫 결과가 성공했는지를 `Jev shadow` 이력 카드로 남깁니다. 이는 추천과 행동의 일치 여부를 관찰하는 지표이며, 추천이 적절했거나 작업 전체가 성공했다는 증명은 아닙니다. 스킬 로드 여부는 이 지표에 포함되지 않습니다.

예상 비용은 [TypeSafe Jev 1.13 공개 요금](https://docs.typesafe.ai/models)을 기준으로 입력 100만 토큰당 $0.042, 출력 무료로 계산합니다. API 응답의 모델이 `jev-1.13.0`이 아닌 경우 요금을 임의로 추정하지 않고 비용을 `unavailable`로 표시합니다. 실패한 API 요청에는 사용량 정보가 없어 집계할 수 없습니다.

### 판단 범위

`decisions`에서 필요한 항목을 선택합니다. `skills`, `nextAction`, `toolDiscovery`, `resultAssessment`, `loopDetection`, `completion`의 기본값은 `true`이고 나머지는 `false`입니다.

| 항목 | 사용 시 동작 |
| --- | --- |
| `skills` | 로드된 스킬 목록에서 적합한 스킬을 제안합니다. |
| `nextAction`, `toolDiscovery` | 현재 활성 도구 중 다음에 쓸 도구를 제안합니다. 두 항목은 현재 동일한 도구 선택 질문을 켭니다. `tool_search`도 활성 도구라면 후보에 포함될 수 있습니다. |
| `resultAssessment` | 최근 도구 결과의 진행도를 평가합니다. 낮은 점수(0.5 미만)가 연속 두 번 나오면 새 근거를 찾거나 접근 방식을 바꾸도록 제안합니다. 실행을 제어하지는 않습니다. |
| `loopDetection` | 최근 결과가 같은 실패를 반복하는지 판단해 접근 방식 재검토를 제안합니다. |
| `completion` | 완료 가능성을 제안합니다. 작업을 강제로 끝내지 않습니다. |
| `toolActivation` | `act`에서 `activatableTools`에 지정한 도구만 추가로 활성화할 수 있습니다. |
| `toolPreflight` | `act`에서 제안된 도구 호출이 요청 범위 밖이라고 판단되면 실행 직전에 차단할 수 있습니다. |
| `modelRouting` | `act`에서 `models`에 나열한 사용 가능한 모델 중 세션 모델을 선택할 수 있습니다. |
| `thinkingLevel` | `act`에서 세션의 사고 수준을 선택할 수 있습니다. |

Jev 판단은 사용자 요청이 시작될 때만이 아니라, **도구 결과를 받은 후 이어지는 에이전트 턴마다** 갱신됩니다. 동일한 상태에 대한 중복 판단은 건너뜁니다. 모델이 이미 선택한 호출을 다른 도구 호출로 바꾸지는 않습니다.

추가 옵션은 예시 설정 파일에 있습니다.

- `model`: Jev API 모델. 기본값 `jev-1.13.0`.
- `apiKey`: 설정 파일의 API 키. 지정하지 않으면 `TYPESAFE_API_KEY`를 사용합니다.
- `endpoint`: Jev API 기본 주소. 지정하지 않으면 SDK 기본 주소를 사용합니다.
- `models`: `modelRouting` 후보. `["provider/model-id"]` 형식이며 현재 세션에서 사용 가능한 모델만 고려합니다.
- `activatableTools`: `toolActivation`의 도구 이름 허용 목록. 기본값은 빈 목록입니다.
- `limits.timeoutMs`, `limits.maxCallsPerAgentRun`, `limits.stateChars`: 호출 시간(기본 1,000ms), 실행당 최대 호출 수(30회), 요청·결과 텍스트 길이(2,000자)를 제한합니다.
- `thresholds.fit`, `thresholds.confidence`, `thresholds.risk`: 적합도, 선택 확신도, 호출 차단 기준입니다. 기본값은 각각 `0.6`, `0.65`, `0.8`입니다.
- `preflightOnError`: 호출 사전 검사에 실패했을 때 `act` 모드에서 호출을 `allow`(기본값)할지 `block`할지 선택합니다.
- `skillRerank`: 켜면 스킬이 24개 이상일 때 1차 후보 세 개의 `SKILL.md` 앞 500자까지 읽어 추가 Jev 호출로 재선별합니다. 기본값은 `false`이며 스킬 본문 일부가 TypeSafe에 전송됩니다. 남은 호출 한도가 한 번뿐이면 재선별을 건너뜁니다.
- `redactValues`, `redactPatterns`: Jev로 보내는 요청·도구 결과·도구 인자·후보 설명에서 지정한 문자열 또는 정규식 일치 부분을 일정한 자리표시자로 치환합니다. 기본값은 빈 목록입니다. `redactPatterns`는 JavaScript 정규식 본문 목록이며 빈 문자열과 일치하는 패턴은 허용하지 않습니다. 후보 이름이 치환되어 서로 구분되지 않으면 제안을 보류합니다.

## 전송되는 데이터와 문제 해결

Jev API를 켜면 잘린 사용자 요청과 최근 도구 이름·성공/오류 상태가 TypeSafe로 전송됩니다. 스킬·도구·모델 후보의 이름과 설명도 질문에 포함됩니다. 도구 출력 본문은 기본적으로 전송하지 않습니다. `includeToolErrors: true`로 설정하면 실패한 도구의 텍스트 일부만, `includeToolOutput: true`로 설정하면 성공한 결과를 포함한 텍스트 일부를 전송합니다. 결과 텍스트는 `limits.stateChars`로 길이를 제한하지만 오류 메시지에도 비밀값이 들어갈 수 있습니다. `toolPreflight`를 켜면 해당 호출의 인자도 길이를 제한해 보냅니다. 민감한 작업에서는 전송 범위를 검토하세요.

제안용 Jev 요청이 실패하면 해당 판단을 건너뛰고 senpi의 일반 동작을 유지합니다. `toolPreflight`의 실패 시 차단 여부는 `preflightOnError`가 결정합니다. 플러그인이 동작하지 않으면 `TYPESAFE_API_KEY`, `mode`, JSONC 오류 경고, 프로젝트 신뢰 상태를 확인하세요.

개발과 릴리스에 참여하려면 [CONTRIBUTING.md](./CONTRIBUTING.md)를 참고하세요.
