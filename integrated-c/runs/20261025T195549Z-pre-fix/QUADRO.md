# Avaliacao integrada de C: quadro de casos

Gerado por `build-report.mjs` a partir de 2 execucao(oes): run-1, run-2.
Fonte de cada linha: `run-1/public/public-summary.json`, `run-1/composition/composition-summary.json`, `run-1/mutant/mutant-control.json`.

## Resumo por caso

| Caso | Criterios | Atendidos | Resultado |
|---|---:|---:|---|
| E1.5 | 2 | 2 | passa |
| E1.1 | 3 | 3 | passa |
| E2 | 17 | 15 | FALHA |
| E1.2a | 1 | 1 | passa |
| E1.2b | 1 | 1 | passa |
| E1.2c | 1 | 1 | passa |
| E1.3 | 1 | 1 | passa |
| E1.4 | 1 | 1 | passa |
| E1.2c-controle | 1 | 1 | passa |

## Criterios (execucao run-1)

| Criterio | Descricao | Esperado | Observado | OK |
|---|---|---|---|---|
| E1.5-http | todas as requisicoes responderam 2xx e ecoaram o x-request-id | status 2xx; eco igual | e15a:200 e15b:201 e15c:200 | sim |
| E1.5-ident | cada requisicao tem exatamente um evento, com o generation_id e o custo do proprio marcador | trocas = 0 | trocas = 0 | sim |
| E1.1-http | todas as requisicoes responderam 2xx e ecoaram o x-request-id | status 2xx; eco igual | e11a:200 e11b:201 e11c:200 e11d:201 e11e:200 | sim |
| E1.1-ident | cada requisicao tem exatamente um evento, com o generation_id e o custo do proprio marcador | trocas = 0 | trocas = 0 | sim |
| E1.1-ordem | ordem de termino no provedor inversa a ordem de partida | e11e,e11d,e11c,e11b,e11a | e11e,e11d,e11c,e11b,e11a | sim |
| E2-http | todas as chamadas responderam 2xx | 2xx | e2a:200 e2b:200 e2c:200 e2d:200 e2e:201 | sim |
| E2.a-evento | custo conhecido gravado igual ao servido | 0.0311 | 0.03110000 | sim |
| E2.b-evento | retry: final em cost_usd, anterior em failed_attempts_cost_usd, 2 tentativas | cost=0.0344 failed=0.0122 attempts=2 | cost=0.03440000 failed=0.01220000 attempts=2 | sim |
| E2.c-evento | texto sem usage: custo NULL (desconhecido), nao zero | cost=NULL | cost=null | sim |
| E2.d-evento | zero real gravado como 0 | cost=0 | cost=0.00000000 | sim |
| E2.e-evento | SSE sem usage: custo NULL (desconhecido) | cost=NULL | cost=null | sim |
| E2-eventos | um evento por operacao (sem dupla contagem da tentativa final) | 5 | 5 | sim |
| E2-rel-total | relatorio: totalCostInUsd = soma do custo informado (inclui tentativa anterior cobrada) | 0.0777 | 0.0777 | sim |
| E2-rel-desconhecido | relatorio: unknownCostRequests = operacoes sem custo final | 2 | 2 | sim |
| E2-rel-gratis | relatorio: freeRequests conta so o zero real (desconhecido nao vira gratuito) | 1 | 1 | sim |
| E2-rel-completo | relatorio: total so pode ser lido como completo se unknownCostRequests = 0; aqui deve sinalizar incompleto | unknownCostRequests > 0 e total < cobrado | unknown=2 total=0.0777 cobrado=0.1153 | sim |
| E2-rel-modelo | relatorio: soma por modelo = totalCostInUsd | 0.0777 | 0.0655 | NAO |
| E2-met-api-custo | metrica API: delta de ai_cost_usd_total = custo informado | 0.0777 | 0.0777 | sim |
| E2-met-api-desconhecido | metrica API: delta de ai_cost_unknown_total = operacoes sem custo final | 2 | 2 | sim |
| E2-met-curador | metrica curador: delta de curator_ai_cost_usd_total = custo informado | 0.0777 | 0.0777 | sim |
| E2.f-rel-gratis | so desconhecido: freeRequests = 0 e unknownCostRequests = 1 | free=0 unknown=1 | http=200 free=0 unknown=1 | sim |
| E2.f-rel-modelo-gratis | so desconhecido: isFree por modelo = false (desconhecido nao vira gratuito) | isFree=false | isFree=true | NAO |
| E1.2a-identidade | sonda de composicao (use-cases): 4 operacoes; eventos corretos / sem atribuicao / trocas | trocas = 0 | eventos=4 corretos=4 sem_atribuicao=0 desconhecidos=0 trocas=0 | sim |
| E1.2b-identidade | sonda de composicao (deferred): 4 operacoes; eventos corretos / sem atribuicao / trocas | trocas = 0 | eventos=4 corretos=4 sem_atribuicao=0 desconhecidos=0 trocas=0 | sim |
| E1.2c-identidade | sonda de composicao (deferred-no-key): 3 operacoes; eventos corretos / sem atribuicao / trocas | trocas = 0 | eventos=3 corretos=0 sem_atribuicao=3 desconhecidos=3 trocas=0 | sim |
| E1.3-identidade | sonda de composicao (deferred): 2 operacoes; eventos corretos / sem atribuicao / trocas | trocas = 0 | eventos=2 corretos=2 sem_atribuicao=0 desconhecidos=1 trocas=0 | sim |
| E1.4-identidade | sonda de composicao (use-cases): 2 operacoes; eventos corretos / sem atribuicao / trocas | trocas = 0 | eventos=2 corretos=2 sem_atribuicao=0 desconhecidos=0 trocas=0 | sim |
| E1.2c-mutante-FIFO | controle negativo: com pareamento por posicao, o teste deve acusar trocas | trocas > 0 | eventos=3 corretos=1 trocas=2 | sim |

## Determinismo entre execucoes

Sem divergencia: 2 execucoes com o mesmo resultado e os mesmos valores observados em todos os 28 criterios.
