# Guessless oracle part 2

Evidence ID: `oracle-part-2-v1`.
Superseded manifest SHA-256: `f43d73071cbe46a581039135cc8df29a6f8ce198df42193c3be82057571b61e9`.

Three pinned licensed repositories were indexed from verified clean archives without installed dependencies. Receipts are useful, integrity-valid, canonically replayable, and retain complete/partial/refused states without claiming unknown ground truth.

Receipt-state census: `{"partial":6,"complete":3}`.
Named unresolved-reason census: `{"unresolved-symbol":21,"unparsed-file":117,"external-module-boundary":122,"unresolved-specifier":2}`.

mcpls/typescript-language-server produced 3 useful repository comparisons. LSP performs well at editor-style definition/reference lookup when its project model initializes; exact diagnostics and limitations are retained verbatim and are not treated as ground truth.

Performance records contain exact 10k, 100k, and 1M physical-line inputs, three cold trials, one query warmup, 30 raw samples for all nine queries, p50/p95, hashes, process caps, and machine/tool metadata.

10000 lines cold total (ns): 1068834, 404333, 356541.
10000 lines query p50/p95 (ns): definitionOf=1029958/1270208, referencesOf=2110292/2373250, readsOf=2108667/2368000, writesOf=2015750/2161333, exportedNames=2436458/2621041, capturesOf=1304459/1428417, resolveBinding=301167/397125, reachableFrom=1341167/1450458, reaches=1335375/1486417.
100000 lines cold total (ns): 3633750, 3164542, 3094417.
100000 lines query p50/p95 (ns): definitionOf=10407125/12406208, referencesOf=20296208/22684458, readsOf=18955625/22844166, writesOf=18963666/22050875, exportedNames=26045042/28682875, capturesOf=13616584/15241709, resolveBinding=2939042/3993584, reachableFrom=12893083/14801625, reaches=13364750/15097625.
1000000 lines cold total (ns): 33321792, 37175041, 32806833.
1000000 lines query p50/p95 (ns): definitionOf=100551250/109188167, referencesOf=203298584/213211375, readsOf=202324625/214440250, writesOf=202978125/212399250, exportedNames=269819458/278859667, capturesOf=134506625/141337583, resolveBinding=33323291/40602500, reachableFrom=134419917/142491292, reaches=134157209/143243958.

Repository index sizes (files/bytes): react-boilerplate-v4=222/234270, react-realworld-cra1=38/63115, angular-phonecat=19/15944.
The synthetic workload is one TypeScript file with nine fixed code lines plus comment padding. It measures physical-line scaling, not real-project complexity.
