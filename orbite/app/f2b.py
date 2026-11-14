"""Debannir une adresse de fail2ban, par son socket monte dans le conteneur (facultatif)."""
import os
import shutil
import subprocess

SOCK = os.environ.get("ORBITE_F2B_SOCK", "/var/run/fail2ban/fail2ban.sock")


def available():
    return bool(shutil.which("fail2ban-client")) and os.path.exists(SOCK)


def unban(ip):
    if not available():
        return False, "fail2ban n'est pas joignable depuis Orbite. Sur le serveur : sudo fail2ban-client unban " + ip
    try:
        r = subprocess.run(["fail2ban-client", "-s", SOCK, "unban", ip], capture_output=True, text=True, timeout=15)
    except Exception as ex:
        return False, "fail2ban-client a échoué : " + repr(ex)[:120]
    if r.returncode != 0:
        return False, "fail2ban a refusé : " + ((r.stderr or r.stdout or "").strip()[:160] or "erreur inconnue")
    return True, ""
