# Import Lusciana

Ce dossier contient tout le necessaire pour preparer puis lancer l'import historique des agents et commissions depuis le fichier Excel.

## Fichiers

- `Comptabilite-Lusciana.xlsx`
- `export-lusciana-workbook.py`
- `import-lusciana-xlsx.py`
- `requirements-lusciana.txt`

## Ou placer le dossier sur le VPS

Le plus simple est de recopier le dossier `scripts/` dans :

```text
/home/luna/luna-admin/scripts
```

Le script Python est prevu pour fonctionner depuis le projet `luna-admin` et lit automatiquement :

```text
/home/luna/luna-admin/backend/.env
```

## Installation minimale

```bash
cd /home/luna/luna-admin
python3 -m pip install --user -r scripts/requirements-lusciana.txt
```

## 1. Generer le preview

```bash
cd /home/luna/luna-admin
python3 scripts/import-lusciana-xlsx.py \
  --source "/home/luna/luna-admin/scripts/Comptabilite-Lusciana.xlsx" \
  --output "/home/luna/luna-admin/scripts/lusciana-import-preview.json"
```

## 2. Lancer l'import reel

Avant cette etape, fais un backup MongoDB.

```bash
cd /home/luna/luna-admin
python3 scripts/import-lusciana-xlsx.py \
  --source "/home/luna/luna-admin/scripts/Comptabilite-Lusciana.xlsx" \
  --output "/home/luna/luna-admin/scripts/lusciana-import-preview.json" \
  --write
```

## Notes

- Le script ecrit dans MongoDB en utilisant `MONGODB_URI` et `MONGODB_DATABASE` depuis `backend/.env`.
- Les associes detectes dans le fichier Excel sont importes comme `builder` par defaut.
- Les commissions importees correspondent aux evenements comptables detectes dans le classeur.
