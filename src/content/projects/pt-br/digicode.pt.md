---
lang: "pt"
page: "digicode"
title: "Digicode"
subtitle: "Tecnologia a serviço da proteção do aleitamento materno"
description: "Como ajudei a tornar auditável e segura uma plataforma que documenta a publicidade digital irregular de substitutos do leite materno."
pubDate: 2026-11-21
tags: ["Python", "FastAPI", "Governança de IA", "Supply chain security", "Saúde pública"]
featured: true
order: 1
logo:
  src: "/images/projects/digicode/fiocruz-logo.svg"
  alt: "Fiocruz – Fundação Oswaldo Cruz, Ministério da Saúde"
  href: "https://portal.fiocruz.br/"
meta:
  - label: "Papel"
    value: "Consultor independente: arquitetura, qualidade de código, IA aplicada e infraestrutura"
  - label: "Coordenação do projeto"
    value: "Cristiano Boccolini, pesquisador da Fiocruz"
  - label: "Período"
    value: "Julho a novembro de 2026"
  - label: "Stack"
    value: "Python 3.12, FastAPI, pytest, ruff, mypy, GitHub Actions, Tesseract OCR, Ollama"
  - label: "Entregas"
    value: "31 PRs mesclados, 25 de 26 ADRs do projeto, 1 relatório de arquitetura e governança, 1 desenho de infraestrutura"
highlights:
  - value: "31"
    label: "PRs mesclados"
  - value: "42"
    label: "vulnerabilidades em dependências fechadas"
  - value: "1 → 4"
    label: "superfícies de coleta com governança honesta"
  - value: "−43%"
    label: "no maior módulo (3.849 → 2.211 linhas)"
---

## O problema

O marketing de fórmulas infantis é uma das causas conhecidas da queda do aleitamento materno. Por isso o Código Internacional de Comercialização de Substitutos do Leite Materno, da OMS (1981), e, no Brasil, a NBCAL (Lei 11.265/2006) restringem como fórmulas, compostos lácteos, mamadeiras e bicos podem ser anunciados.

A fiscalização foi pensada para a TV, a embalagem e o ponto de venda. Hoje a publicidade está em anúncios pagos no Google e na Meta, em vídeos no YouTube e em páginas de varejo online. O volume é grande, o conteúdo some depois que a campanha acaba e cada plataforma expõe os dados de um jeito. Em 2022, a OMS e a UNICEF documentaram como o marketing digital de fórmulas se tornou sistemático e difícil de acompanhar.

## O que é o Digicode

O Digicode é uma **infraestrutura de evidências em saúde pública**. Ele coleta anúncios públicos das bibliotecas de transparência das plataformas (Google Ads Transparency Center, Meta Ad Library, YouTube) e do varejo online, preserva cada peça com proveniência e hash, extrai texto por OCR e passa o material por uma cadeia de classificação auditável. O resultado são casos organizados para revisão humana por autoridades sanitárias, sociedade civil e pesquisadores. Uma trilha separada aplica o mesmo processo a alimentos ultraprocessados.

O manifesto metodológico do projeto deixa claro o que o sistema **não** é: ele não é um detector automático de infrações. Quem decide se houve infração é a autoridade competente. O papel do sistema é garantir que essa decisão se apoie em evidência íntegra. Quatro princípios orientam o desenho:

- **Evidência antes do julgamento.** Primeiro se registra o que está visível, onde foi encontrado e como foi capturado. A interpretação vem depois.
- **Nenhuma falha silenciosa.** Todo registro termina com um estado e um motivo auditáveis. "Fora de escopo" não é exclusão, e a ausência de OCR não é tratada como ausência de conteúdo regulado.
- **Na dúvida, reter.** Casos ambíguos vão para `safe_hold`. O sistema nunca os resolve sozinho como "não é violação".
- **Padrão, não só incidente.** Um anúncio isolado pode ser defendido como exceção. Uma estratégia sustentada de exposição em várias superfícies é mais difícil de contestar.

A arquitetura é multipaís: a camada de evidência e as referências internacionais são compartilhadas, e as regras nacionais ficam isoladas por país.

## Meu papel

Entrei no projeto para revisar o código e propor melhorias. O trabalho cresceu para arquitetura, segurança, governança dos classificadores e infraestrutura. Toda mudança seguiu o mesmo ciclo:

1. **Investigar antes de propor.** Ler o código atual, medir e confirmar o problema na `main` de hoje.
2. **Planejar por escrito.** Uma proposta de mudança (OpenSpec) e um ADR com o contexto, as opções consideradas e a decisão.
3. **Aprovar com o coordenador.** Nenhuma decisão de arquitetura entrou sem aprovação explícita.
4. **Implementar com prova.** Testes para cada comportamento novo, todos os gates do CI verdes e comparação de AST nas refatorações.
5. **Registrar o que deu errado.** O relatório final tem uma seção sobre os meus próprios erros de estimativa.

Usei LLMs de forma intensiva e declarada. Houve revisão de código com vários agentes especialistas em paralelo, verificação adversarial dos achados e consultas independentes a perfis de IA, DevOps e arquitetura antes do desenho de infraestrutura. A responsabilidade técnica por cada decisão continuou sendo minha.

---

## Entregas técnicas

O trabalho foi organizado em quatro faixas, priorizadas por risco.

### Faixa 1: o sistema dizia que estava tudo certo sem medir nada

**Achado.** O conector piloto do Google era o único caminho autorizado a rodar com dados reais. A cada execução ele gravava quatro registros de governança (`ExecutionRun`, `ReplayInput`, `ReplayResult`, `DriftReport`) que alimentam os gates de promoção do projeto: orçamentos de falso positivo, falso negativo, perda de cobertura e divergência de regras. Os valores estavam fixos no código, sempre com resultado `match`, deltas `0.0` e status `within_budget`. Os gates ficavam verdes por construção, não por avaliação. Quatro revisões especialistas independentes chegaram a esse achado, o mais grave do assessment, e uma verificação adversarial o confirmou.

**Decisão (ADR-0002).** Quando não houve comparação com uma linha de base, a execução passa a reportar `not_evaluable`. Um bloqueio de promoção explícito impede que "não avaliado" seja lido como "aprovado".

**Por que importa.** Em compliance, um falso "tudo certo" é pior do que nenhum indicador. Ele dá a gestores e revisores uma confiança que o sistema não tinha como sustentar.

### Faixa 2: segurança da cadeia de suprimentos e do plano de controle

- **42 vulnerabilidades em dependências fechadas** (11 no lock de produção e 31 no de desenvolvimento; só o `starlette`, a camada HTTP da API, tinha 7). Comparei duas estratégias antes de escolher. A atualização geral movia 34 de 56 pacotes. A atualização cirúrgica movia **5**, zerava os alertas e não mexia nas ferramentas dos gates do CI. Adotei a cirúrgica. *(ADR-0003)*
- **Gate de vulnerabilidade no CI** com `pip-audit`, mais Dependabot para avisar entre builds. *(ADR-0003)*
- **Sincronia do lock.** Um bump de `pytest` para corrigir uma CVE não teve efeito nenhum no CI, porque o CI instala só a partir do lock e o lock continuava na versão antiga. Criei um verificador que reprova o build quando uma versão travada viola uma restrição declarada. Escolhi comparar em vez de regenerar, e o ADR documenta o motivo e o limite: um lock apenas desatualizado não é detectado. *(ADR-0006)*
- **"Não configurado" passou a significar "fechado".** Os endpoints de escrita da API (disposições de revisão, exportações, contestações) aceitavam gravações anônimas e gravavam a identidade do revisor a partir do corpo da requisição, que o chamador controla. A autenticação agora é obrigatória por padrão. *(ADR-0004)*
- **Proteção da `main`.** Corrigi um `CODEOWNERS` que não funcionava e criei um verificador automático das configurações de proteção do repositório. *(ADR-0005)*

### Faixa 3: governança dos classificadores em todas as superfícies

Ao implementar a Faixa 1, o coordenador perguntou: *"por que essa correção foi aplicada apenas no Google e não no Meta?"*. A pergunta revelou que o assessment de julho tinha rodado sobre um branch defasado em cinco dias, anterior à ativação da coleta em quatro superfícies. Recalibrei o roteiro com dados da matriz de autorização: **o Meta respondia por 79% do volume autorizado, o Google por 13%, o varejo por 4% e o YouTube por 3%.** Os três que não gravavam nenhum registro de governança somavam 87% do volume.

- **Contrato de setup genérico por plataforma.** O registro de autorização compartilhado rejeitava, por construção, qualquer superfície que não fosse o Google. *(ADR-0009)*
- **Attestation honesta para Meta, varejo e YouTube**, cada um com o mesmo contrato do Google, mais catálogo e classificação por registro. *(ADR-0010 a ADR-0016)*
- **Trilha de auditoria das revisões humanas.** A documentação afirmava que o ledger encadeado por hash das decisões dos revisores era verificado pela rotina de integridade da plataforma, mas ele não era. Fechei essa lacuna. A decisão do revisor é o controle final do sistema e só vale como evidência se for possível provar quem decidiu, quando, e que nada foi alterado depois. *(ADR-0008)*
- **Ledger de falsos negativos.** Para medir drift de verdade é preciso uma referência adjudicada por humanos dos dois lados. O lado dos falsos positivos já tinha uma; o dos falsos negativos não tinha nenhuma. *(ADR-0017)*
- **Harness de replay de auto-consistência.** Reclassifica registros já capturados e compara o resultado com a classificação original, o que produz o primeiro par real de antes e depois para o `DriftReport`. *(ADR-0018)*

### Faixa 4: reduzir o maior arquivo sem mudar comportamento

O `collection_executor.py` tinha **3.849 linhas e cerca de 90 funções**, misturando execução de subprocessos, watchdog, checkpoints, circuit breaker, ledger, classificação de varejo e geração de relatórios.

Apliquei o padrão **strangler fig**: um módulo extraído por vez, com a suíte de testes existente como rede de segurança. Foram sete extrações (`pipeline_utils`, `retail_classification`, `summary_reports`, `bindings`, `checkpoints`, `circuit_breaker`, `ledger`), cada uma com plano, ADR e **comparação da árvore sintática (AST)** de cada função movida contra a `main`, para provar que a lógica ficou idêntica. Também dividi o `who/_helpers.py` (1.694 linhas, 12 detectores de sinais da OMS) em um módulo por detector. *(ADR-0019 a ADR-0026)*

**Resultado:** de 3.849 para **2.211 linhas (−43%)**, com a `main` verde em cada merge.

Quando a `main` mudava funções que eu já tinha movido, **portei as versões novas** para os módulos extraídos em vez de descartá-las e confirmei de novo por AST. Uma correção normativa da OMS feita em paralelo foi preservada: 29 de 30 símbolos ficaram idênticos, e o trigésimo diferia só no caminho do import.

### Performance: OCR mais rápido, medido do jeito certo

O OCR representa cerca de **86% do custo** do pipeline do Google, contra 14% de codificação de imagem. A cascata preparava cinco variantes de cada imagem mesmo quando a primeira bastava. Passei a gerar as variantes sob demanda (preparação lazy).

A primeira medição foi enganosa: rodei as duas versões em sessões diferentes, e a variação entre sessões (~390 ms) era maior que o efeito medido. Refiz com **A/B intercalado** na mesma sessão:

| Cenário | Antes | Depois | Diferença |
|---|---|---|---|
| Saída antecipada, 1 chamada de OCR | 4.049,6 ms | 3.600,1 ms | **−449 ms (−11,1%)** |
| Cascata completa, 8 chamadas | 1.524,3 ms | 1.521,6 ms | −2,6 ms (neutro) |

Também testei trocar PNG por formatos sem compressão. Eles deixariam cada variante **183 ms mais lenta**, então o PNG ficou. *(ADR-0007)*

### Infraestrutura: um servidor físico com LLM local

Desenhei a infraestrutura para rodar a aplicação, o gate de testes e um **LLM local com Ollama** num servidor físico, com ambientes Dev/Staging/Prod, rede e VPN, e segredos fora do repositório. As escolhas principais:

- **Orquestrador multi-nó descartado nesta fase** (k3s/Swarm): a complexidade não se justifica num único servidor.
- **Levantamento do hardware antes de dimensionar.** GPU e VRAM decidem se o Ollama roda com GPU ou em CPU, e sem AVX2 o throughput em CPU cai de 2 a 3 vezes.
- **Concorrência entre Ollama e Tesseract** pela mesma CPU tratada como risco real, já que o OCR é 86% do custo.
- **Processamento local**, para que evidências e dados sensíveis não precisem sair para uma API externa de LLM.

---

## Resultados

| Indicador | Valor |
|---|---|
| PRs mesclados com o meu trabalho | 31 |
| ADRs escritos | 25 de 26 |
| Vulnerabilidades em dependências fechadas | 42 (11 em produção) |
| Superfícies de coleta com governança honesta | de 1 para 4 (de 13% para praticamente 100% do volume autorizado) |
| Tamanho do maior módulo | 3.849 → 2.211 linhas (−43%) |
| Latência do OCR no caso mais comum | −11,1% |
| Estado do projeto em 03/11/2026 (trabalho do time) | 5.757 testes passando, 85,1% de cobertura (gate mínimo: 70%) |

## O que aprendi

- **Um assessment vale tanto quanto a base sobre a qual roda.** Cinco dias de defasagem distorceram a priorização inteira. Hoje confiro o `merge-base` antes de qualquer avaliação.
- **Estimativas de refatoração erram quando o código continua andando.** Previ cerca de 2.500 linhas depois da quarta faixa e cheguei a 2.996 naquele ponto, porque a `main` ganhou código novo no mesmo arquivo. Registrei o erro no relatório em vez de escondê-lo.
- **Medir mal é pior do que não medir.** A primeira medição do OCR teria aprovado uma conclusão errada.
- **Segurança de dependências é recorrente, não pontual.** Novos avisos travaram o CI de todos os PRs em setembro e em outubro. A atualização de dependências virou a etapa zero de cada fila de merges.

## O que ainda está em aberto

- Aplicar a proteção da `main` depende do administrador do repositório. O verificador já existe.
- O drift entre versões de classificador depende de dados adjudicados por humanos, e o ledger de falsos negativos foi criado para começar a acumulá-los.
- A decomposição do `collection_executor.py` segue com os módulos restantes do plano.

---

## Referências

- OMS. [International Code of Marketing of Breast-milk Substitutes](https://www.who.int/publications/i/item/9241541601) (1981)
- Brasil. [Lei nº 11.265/2006 (NBCAL)](https://www.planalto.gov.br/ccivil_03/_ato2004-2006/2006/lei/l11265.htm)
- OMS/UNICEF. [How the marketing of formula milk influences our decisions on infant feeding](https://www.who.int/publications/i/item/9789240044609) (2022)
- Martin Fowler. [Strangler Fig Application](https://martinfowler.com/bliki/StranglerFigApplication.html)
- Michael Nygard. [Documenting Architecture Decisions](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)
- OpenSSF. [SLSA: Supply-chain Levels for Software Artifacts](https://slsa.dev/)
- PyPA. [pip-audit](https://github.com/pypa/pip-audit)
- [Ollama](https://ollama.com/)
