L'objectif ici va être de récupérer le maximum d'informations concernant des commissions. J'ai bien dit le MAXIMUM. Là le but c'est de surtout garder une cohérence, de trouver le maximum d'information et de les rassembler, les confrontées, être smart car je vais te donner en input tout un tas de donnée que tu devras analyser et en faire des commissions ici en bas pour un stockage plus performant. N'utilise pas de script afin d'arriver à tes fins mais juste de lire les données. Tout se trouve dans /import je veux en output un .json que tu créer.

Importante règle, il en faut pas, absolument pas que tu mettes un ticket = une commission ou un virement = une commission, non tu dois être réellement smart et comprendre le doc, pour le prix etc, si tu vois premier paiement, tu dois certainement avoir un second paiement, etc..

L'IA a a sa disposition une liste de virement paypal permettant de retrouver les commissions, attention faudra être smart poru retrouver les bons pseudos à qui ils sont etc, l'IA a également à sa disposition le salon Transcript avec la liste de tous les noms des tickets pour également avoir potentiellement les dates. Et le PLUS important, un fichier csv de comptabilité de l'équipe, alors là il faudra être très smart pour repérer et former des commissions.



{
  "buildSize": "",
  "buildName": "",
  "worldName": "c-",
  "realizedBy": ,
  "version": "",
  "forCustomer": "yes/no",
  "price": ,
  "buildStart": "",
  "buildEnd": "",

  "depositAmount": ,
  "buildType": "commission",
  "organics": "yes",
  "selectedAgents": ["", ""],
  "priceDistribution": { (en %, par défaut 50-50 si non renseigné)
    "Spinophore": ,
    "bezubica": 
  },
  "commissionPercent": 15.0 (par défaut 15 sauf si manager),
  "wentWell": "yes",
  "clientName": "",
  "clientWants": "",
  "hasFeedback": "yes/no",
  "clientFeedback": "",
  "render": "yes/no",
  "showcaseText": "",
}


Les données seront un long transcripts et également de la comptabilité. 