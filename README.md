# Discoveradio

Webradio synchrone : tout le monde écoute le même morceau au même moment, la commu propose les morceaux, vote, réagit et discute en direct.

## Démarrer en local

```bash
cp .env.example .env
# dans .env : ALLOW_DEV_LOGIN=1 et ADMIN_EMAILS=ton@email.fr (login sans Google, local uniquement)
docker compose up --build
```

Ouvre http://localhost. Port 80 déjà pris ? Mets `HTTP_PORT=8080` et `BASE_URL=http://localhost:8080` dans `.env`.

Connecte-toi avec l'email listé dans `ADMIN_EMAILS` : tes envois sont publiés directement, ce qui amorce la radio. Modération : `/admin.html`.

## Architecture

| Service | Image | Rôle |
|---|---|---|
| `caddy` | `caddy:2-alpine` | Point d'entrée unique, HTTPS automatique en production |
| `app` | build local | Diffusion synchronisée, comptes, uploads, modération |
| `db` | `postgres:16-alpine` | Morceaux, votes, sessions, état de l'antenne |
| `ergo` | `ghcr.io/ergochat/ergo` | Serveur de chat (IRC), config dans `docker/ergo/ircd.yaml` |
| `kiwi` | `kiwiirc/kiwiirc` | Client de chat web, affiché dans une iframe |

Le chat n'a aucun code maison : le pseudo des utilisateurs connectés est injecté via la config de Kiwi, générée par l'app (`/kiwi-config.json`). Les invités chattent sous un pseudo `Auditeur123`. Les IP sont masquées, les messages limités en débit, et les nouveaux arrivants voient l'historique récent. Pour désactiver le chat : `CHAT_ENABLED=0`.

## Mise en production

1. Un domaine qui pointe vers ton serveur, ports 80 et 443 ouverts.
2. Dans `.env` : `SITE_ADDRESS=radio.mondomaine.fr`, `BASE_URL=https://radio.mondomaine.fr`, un vrai `SESSION_SECRET` (`openssl rand -hex 32`), `ALLOW_DEV_LOGIN=0`.
3. Google OAuth : client « Application Web », URI de redirection `https://radio.mondomaine.fr/auth/google/callback`, puis `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
4. `docker compose up -d --build`.

L'app refuse de démarrer en https avec le `SESSION_SECRET` par défaut. Pense à sauvegarder les volumes `pgdata` et `uploads`.

## Amorcer la radio sans proposer de morceaux à la main

Dépose des fichiers audio avec leurs tags (artiste obligatoire) dans `./library` : ils sont publiés automatiquement au démarrage de l'app (relance `docker compose restart app` après un ajout).

## Ce qui est en place pour donner envie d'écouter et de poster

- Écoute en un clic, démarrage automatique dès le premier geste, commandes sur l'écran verrouillé, pré-chargement du morceau suivant.
- Réactions en direct, chat, compteur d'auditeurs, classement des morceaux et des découvreurs, historique.
- Le proposant est cité à l'antenne, prévenu quand son morceau est validé puis quand il passe, et voit ses passages, likes et pic d'auditeurs dans « Mes morceaux ».
- Les nouveaux morceaux passent en premier, les morceaux aimés reviennent plus vite, jamais deux morceaux du même proposant à la suite.
- Après 3 morceaux validés (`AUTO_APPROVE_AFTER`) et aucun refus, un utilisateur est publié sans attendre la modération.

## Limites et garde-fous

- Max 3 morceaux en attente et 5 par jour par utilisateur, 30 Mo, de 30 s à 15 min, doublons refusés (empreinte du fichier).
- Case de certification des droits obligatoire. Diffuser de la musique protégée sans autorisation t'expose juridiquement : vise des artistes qui s'auto-publient ou des licences ouvertes, et renseigne `CONTACT_EMAIL` pour les demandes de retrait.
- Les liens directs sont téléchargés côté serveur avec protection contre le SSRF (IP privées, redirections, taille).

## Dépannage

- **Le chat ne se connecte pas** : `docker compose logs ergo kiwi`. Dans la console du navigateur, la requête WebSocket doit viser `ws(s)://ton-domaine/irc`. La config Ergo n'a pas pu être testée à la livraison : si Ergo refuse une clé, le log indique laquelle.
- **Pas de connexion possible** : ni Google ni `ALLOW_DEV_LOGIN=1` configurés.
- **Mot de passe Postgres changé sans effet** : il est figé à la création du volume `pgdata`.
- Les polices viennent de Google Fonts. Pour être 100 % hors tiers (RGPD), héberge-les toi-même (paquet `@fontsource-variable/bricolage-grotesque`).
