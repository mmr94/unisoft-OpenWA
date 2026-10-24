# Maintenance du runtime — 24 octobre 2026

Environnement : **Serveur Mimtech**. Node sélectionné : `/home/mmr/.nvm/versions/node/v24.22.1/bin/node` (24.22.1).

PM2 `openwa`, `/var/www/unisoft-OpenWA`, script `dist/main.js`. Aucune action WhatsApp de test.

Le code métier et les données ne changent pas pour cette correction de runtime.
Les recettes publiées sont dans le dépôt API, `ops/security-20261024`, commits
`84be1f9fde6e435ca6afbac2f0c2f2007b5c99de` puis
`bd6f6a25230f8aa916c3f75baefecd0cd928ec65` pour les contrôles natifs Core.
Elles fixent les identités PM2, les chemins et les empreintes des arguments.
Chaque relance conserve les options et l’environnement privé, sélectionne
l’interpréteur explicite et son PATH, puis vérifie les vrais exécutables des PID
et les erreurs de démarrage. Les installations natives utilisées sont contrôlées
avant relance ; les tests applicatifs restent hors production.

Pour les prochains déploiements, conserver cet interpréteur et placer son dossier
`bin` en tête du PATH des descendants npm/yarn. Ne pas déduire le runtime du seul
`node --version` d’un shell, ni remettre l’ancien interpréteur depuis un ecosystem.
Le gestionnaire PM2 reste en place lors de ces relances ciblées. Aucun `restart all`.

Le snapshot privé du propriétaire PM2 conserve l’interpréteur et les options
précédentes dans `~/.local/share/unisoft-security-20261024/node-dev` ou `node-core`.
Un retour de runtime se fait sur le seul processus concerné après examen des
addons natifs, puis vérification des PID, des logs et du HTTP. Il ne rétablit
jamais une ancienne base, un WAL, un média ou un secret. Le code reste récupérable
par Git ; cette maintenance ne crée pas de copie permanente du projet.
Un retour vers Node 20 ou 24.18.0 réintroduit une dette de sécurité : préférer
un correctif sur une version maintenue et corrigée.

Référence : [publication officielle Node du 21 octobre 2026](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases).
