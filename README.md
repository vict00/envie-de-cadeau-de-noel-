# 🎁 Mes envies de Noël

Un petit site pour partager ma liste de cadeaux. Je colle le lien d'un produit, le site récupère tout seul
la photo, le nom et le prix, et tout le monde peut consulter la liste.

## Mise en ligne (une seule fois)

1. **Envoyer les fichiers sur GitHub** : `git add . && git commit -m "Site" && git push`
2. **Activer GitHub Pages** : sur le dépôt → *Settings* → *Pages* → *Source : Deploy from a branch* →
   branche `main`, dossier `/ (root)` → *Save*.
   Le site sera en ligne en ~1 minute à l'adresse `https://vict00.github.io/envie-de-cadeau-de-noel-/`.
3. **Créer ton jeton pour gérer la liste** : <https://github.com/settings/personal-access-tokens/new>
   - *Repository access* : **Only select repositories** → `envie-de-cadeau-de-noel-`
   - *Permissions* → *Repository permissions* → **Contents : Read and write**
   - Génère-le et copie-le.
4. Sur le site, clique **🔑 Gérer ma liste** en bas de page et colle le jeton.
   Il est gardé uniquement dans ton navigateur (à refaire sur chaque appareil).

## Utilisation

- **Ajouter** : colle un lien → *Ajouter* → vérifie / corrige le nom, le prix ou la photo → *Enregistrer*.
- **Modifier** : ✏️ sur une carte. **Supprimer** : 🗑.
- Les visiteurs (famille, amis) voient la liste sans pouvoir la modifier.

## Bon à savoir

- La récupération automatique passe par le service gratuit [Microlink](https://microlink.io)
  (environ 50 liens par jour). Certaines boutiques ne donnent pas leur prix : tu peux alors le saisir à la main.
- Si plusieurs offres sont trouvées pour un même produit, le site affiche le **prix moyen**.
- La liste est stockée dans `wishes.json` ; chaque ajout ou suppression crée un commit dans le dépôt.
