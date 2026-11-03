# Démarrage rapide — J.A.R.V.I.S. Spatial Edition

## 1. Sur ton PC

1. Installe **Node.js 22 LTS**.
2. Décompresse le ZIP dans un dossier.
3. Ouvre un terminal dans le dossier `JARVIS_Spatial_Edition`.
4. Lance :

   ```bash
   npm install
   npm run dev
   ```

5. Ouvre l'adresse locale affichée par Vite.

Le tableau de bord et les projets locaux sont disponibles sans configurer l'IA. Pour discuter avec le modèle IA, configure Supabase et Groq comme expliqué dans `README.md`.

## 2. Sur le Meta Quest 3

Le casque doit ouvrir la version **HTTPS déployée** du site dans Meta Quest Browser. Une adresse `localhost` sur ton PC n'est pas automatiquement accessible comme `localhost` depuis le casque.

- Appuie sur **Entrer en VR**.
- Avec les mains : approche l'index d'un panneau et pince pouce-index pour activer un bouton ou saisir/déplacer le panneau.
- Avec les manettes : vise un panneau, appuie sur la gâchette pour activer un bouton ou saisir son cadre, puis déplace-le.
- Les positions des panneaux sont mémorisées dans le stockage local du navigateur.

## 3. Publier le site

Le dépôt contient un workflow GitHub Actions dans `.github/workflows/deploy.yml`. Publie le dossier sur GitHub, active GitHub Pages avec **GitHub Actions**, puis pousse sur la branche `main`. Le site sera publié en HTTPS. Supabase reste à déployer séparément pour activer les fonctions IA.

## À savoir

Le mode MR/passthrough dépend de ce que Meta Quest Browser expose réellement à WebXR. Les panneaux sont des objets 3D de l'application, pas des fenêtres natives du système Quest ni des ancres persistantes dans la pièce.
