# Orbite
<img width="1440" height="1000" alt="image" src="https://github.com/user-attachments/assets/149fb0ed-dcb7-4181-9b4d-05db4ad27569" />

Tableau de bord des connexions du serveur : qui se connecte, a quelle application, sur quel
port, avec un historique, des alertes sur les comportements suspects et le journal de fail2ban.

## Installation

```bash
mkdir -p /opt/orbite && tar xzf orbite.tar.gz -C /opt/orbite --strip-components=1
cd /opt/orbite
cp .env.example .env
nano .env                      # mets ORBITE_PASSWORD
chmod 600 .env
docker compose up -d --build
docker logs --tail 20 orbite   # doit afficher « Orbite ecoute sur http://127.0.0.1:8095 »
```

Ensuite, cree un site dans nginx-ui (par exemple `orbite.drgreenthumbs.ca`) avec HTTPS et ceci
dans l'emplacement `/` :

```nginx
proxy_pass http://127.0.0.1:8095;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
```

## D'ou viennent les donnees

| Donnee | Source |
|---|---|
| Connexions, ports, sens, octets | `conntrack -L` (inclut le trafic vers les conteneurs) |
| Nom du programme, latence TCP | `ss` sur l'hote |
| Nom des conteneurs | socket Docker (lecture) |
| Robots et scans web | `/var/log/nginx/access.log` |
| Force brute SSH | `/var/log/auth.log` |
| Bannissements | `/var/log/fail2ban.log` |

Le compteur d'octets reste vide tant que la comptabilite conntrack n'est pas activee sur l'hote :

```bash
echo "net.netfilter.nf_conntrack_acct=1" > /etc/sysctl.d/99-orbite.conf && sysctl --system
```

## Regles de detection

- Balayage de ports : 6 ports differents ou plus en 5 minutes
- Rafale de connexions : 100 nouvelles connexions ou plus en 1 minute
- Sondes sans reponse : 10 tentatives sans reponse en 5 minutes
- Port sensible (SMB, MySQL, Redis, RDP...) sonde ou accessible depuis Internet
- Recherche de failles web (`/.env`, `wp-login.php`, `.git`...), outils de balayage, erreurs 4xx en serie
- Force brute SSH : 5 echecs en 10 minutes
- Echecs sur la page de connexion d'Orbite, et adresses bannies par fail2ban

Les seuils se changent dans `.env` : `ORBITE_PORTSCAN_PORTS`, `ORBITE_FLOOD_PER_MIN`,
`ORBITE_PROBES`, `ORBITE_HTTP_ERRORS_PER_MIN`, `ORBITE_AUTH_FAILS`.

## Bannir une adresse

Le bouton « Bannir » (fiche d'une adresse ou onglet Bannissements) ajoute l'adresse a une table
nftables propre a Orbite (`inet orbite`), placee avant le suivi de connexions. L'adresse est
coupee sur tous les ports, conteneurs Docker compris, et ses connexions en cours sont fermees.
Les bans sont remis en place au demarrage du conteneur.

Avec `ORBITE_ENFORCE_F2B=1` (par defaut), les adresses bannies par fail2ban recoivent le meme
blocage complet tant que fail2ban les garde bannies. Les adresses locales, celles de
`ORBITE_WHITELIST` et ton adresse actuelle ne peuvent pas etre bannies.

Pour tout retirer a la main : `nft delete table inet orbite`.

## Bannissement automatique

Actif par defaut (`ORBITE_AUTOBAN=on`). Une adresse est bannie :

- des sa premiere alerte d'un type coche (par defaut : balayage de ports, recherche de failles
  web, force brute, outil de balayage) ;
- ou quand ses alertes atteignent 6 points en 60 minutes (grave = 3 points, moyenne = 1 point).

Duree par defaut : 24 heures, doublee a chaque recidive. Le mode test signale les adresses qui
auraient ete bannies sans les bloquer. Les adresses locales, la liste blanche et les adresses
connectees a Orbite ne sont jamais bannies automatiquement.

## Actions sur une adresse

Dans la fiche d'une IP : bannir ou debannir (Orbite et fail2ban), effacer ses alertes (elles
restent dans l'historique, marquees comme effacees), la signaler a la main, l'ajouter a la liste
blanche, ou indiquer que c'est ton adresse.

« C'est mon adresse » sert pour ton IP publique : quand tes appareils ouvrent tes propres
domaines depuis chez toi, le routeur les renvoie a l'interieur (boucle NAT) et ils arrivent avec
ton IP publique. Ces connexions passent alors sur l'anneau du reseau local et ne sont jamais
signalees.

Pour debannir de fail2ban, Orbite utilise le socket de fail2ban monte dans
`docker-compose.yml` (`/var/run/fail2ban`). Sans ce montage, la fiche affiche la commande
`sudo fail2ban-client unban <ip>` a lancer sur le serveur.

## Parametres

Le bouton « Parametres » ouvre un panneau a droite : bannissement automatique, seuils de
detection, liste blanche, collecte, affichage, mot de passe et etat du systeme. Les reglages
du serveur sont gardes dans la base de donnees et ont priorite sur le fichier `.env`.
Si tu oublies le mot de passe change dans l'app, arrete le conteneur et lance :
`sqlite3 data/orbite.db "DELETE FROM kv WHERE k='password_hash'"` ; celui du `.env` redevient valide.

## Fiche d'une adresse

En ouvrant la fiche d'une IP, Orbite interroge rdap.org (registre du reseau) et ip-api.com
(pays, fournisseur, type de reseau), puis garde la reponse 7 jours. L'adresse consultee est
donc envoyee a ces deux services. Mets `ORBITE_LOOKUP=0` dans `.env` pour ne rien envoyer.

## A savoir

- Le conteneur tourne avec `network_mode: host`, `pid: host`, `NET_ADMIN`, `SYS_PTRACE` et le
  socket Docker : il a donc un acces etendu a l'hote. Garde-le derriere nginx et HTTPS.
- Les donnees sont dans `./data/orbite.db`. Pour repartir de zero : arrete le conteneur et
  supprime ce fichier.
- Mise a jour apres une modification : `docker compose up -d --build`.
