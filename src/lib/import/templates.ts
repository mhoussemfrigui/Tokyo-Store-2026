/**
 * Downloadable starter templates for the product importer
 * (`/admin/system/import-data`). Kept as plain string constants so the admin UI
 * can serve them as file downloads without any filesystem dependency.
 *
 * The XML template mirrors the Google-Merchant RSS dialect the real
 * tokyostore.tn feed uses (`g:` tags + the custom `cmp:` SEO tags); the CSV
 * template is strictly header + 2 example rows — column semantics are
 * documented in the admin UI, not inside the file.
 */

export const IMPORT_TEMPLATE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0" xmlns:cmp="https://tokyostore.tn/ns/cmp">
  <channel>
    <title>Tokyo Store — modèle d'import produits</title>
    <link>https://tokyostore.tn</link>
    <description>Flux produits au format Google Merchant</description>
    <!--
      Un <item> = un produit. Balises supportées :
        g:id                      identifiant source (facultatif, sert aux messages d'erreur)
        g:title                   nom du produit (obligatoire)
        g:link                    URL d'origine — le slug est dérivé du dernier segment
        g:description             description (CDATA accepté)
        g:image_link              image principale
        g:additional_image_link   images supplémentaires (répéter la balise, 7 max)
        g:price                   prix en dinars, ex. "899.00 TND" (obligatoire)
        g:availability            in_stock | out_of_stock | backorder
        g:condition               état (informatif, non importé)
        g:brand                   marque (créée automatiquement si inconnue)
        g:gtin                    code-barres EAN/UPC — les zéros initiaux sont conservés
        g:mpn                     référence fabricant (sert aussi de SKU)
        g:product_type            chemin de catégorie "Parent / Enfant"
        cmp:meta_title            titre SEO
        cmp:meta_description      description SEO (CDATA accepté)
    -->
    <item>
      <g:id>1001</g:id>
      <g:title>Xiaomi Redmi Note 13 Pro - Smartphone 256 Go</g:title>
      <g:link>https://tokyostore.tn/smartphones/1001-xiaomi-redmi-note-13-pro-256-go-tunisie.html</g:link>
      <g:description><![CDATA[Le Redmi Note 13 Pro : écran AMOLED 6,67 pouces 120 Hz, appareil photo 200 MP et charge rapide 67 W.]]></g:description>
      <g:image_link>https://example.com/images/redmi-note-13-pro.jpg</g:image_link>
      <g:additional_image_link>https://example.com/images/redmi-note-13-pro-dos.jpg</g:additional_image_link>
      <g:price>899.00 TND</g:price>
      <g:availability>in_stock</g:availability>
      <g:condition>new</g:condition>
      <g:brand>Xiaomi</g:brand>
      <g:gtin>6941812762790</g:gtin>
      <g:mpn>RN13PRO-256</g:mpn>
      <g:product_type>Téléphonie / Smartphones</g:product_type>
      <cmp:meta_title>Xiaomi Redmi Note 13 Pro 256 Go en Tunisie | Tokyo Store</cmp:meta_title>
      <cmp:meta_description><![CDATA[Achetez le Xiaomi Redmi Note 13 Pro 256 Go au meilleur prix en Tunisie. Livraison rapide partout.]]></cmp:meta_description>
    </item>
    <item>
      <g:id>1002</g:id>
      <g:title>Écouteurs sans fil Xiaomi Redmi Buds 5</g:title>
      <g:link>https://tokyostore.tn/ecouteurs/1002-xiaomi-redmi-buds-5-tunisie.html</g:link>
      <g:description><![CDATA[Écouteurs Bluetooth à réduction de bruit active, autonomie jusqu'à 38 h avec l'étui de charge.]]></g:description>
      <g:image_link>https://example.com/images/redmi-buds-5.jpg</g:image_link>
      <g:price>119.00 TND</g:price>
      <g:availability>out_of_stock</g:availability>
      <g:condition>new</g:condition>
      <g:brand>Xiaomi</g:brand>
      <g:gtin>6941812749388</g:gtin>
      <g:mpn>M2316E1</g:mpn>
      <g:product_type>Audio / Écouteurs</g:product_type>
      <cmp:meta_title>Xiaomi Redmi Buds 5 en Tunisie | Tokyo Store</cmp:meta_title>
      <cmp:meta_description><![CDATA[Écouteurs sans fil Xiaomi Redmi Buds 5 au meilleur prix en Tunisie.]]></cmp:meta_description>
    </item>
  </channel>
</rss>
`;

export const IMPORT_TEMPLATE_CSV = `name,slug,price_dinars,old_price_dinars,availability,brand,gtin,mpn,category_path,image_url,additional_image_urls,short_desc,description,meta_title,meta_description
Xiaomi Redmi Note 13 Pro - Smartphone 256 Go,xiaomi-redmi-note-13-pro-256-go,899.00,999.00,in_stock,Xiaomi,6941812762790,RN13PRO-256,Téléphonie / Smartphones,https://example.com/images/redmi-note-13-pro.jpg,https://example.com/images/redmi-note-13-pro-dos.jpg|https://example.com/images/redmi-note-13-pro-ecran.jpg,Redmi Note 13 Pro : AMOLED 120 Hz et photo 200 MP.,"Le Xiaomi Redmi Note 13 Pro : écran AMOLED 6,67 pouces 120 Hz, appareil photo 200 MP et charge rapide 67 W.",Xiaomi Redmi Note 13 Pro 256 Go en Tunisie | Tokyo Store,Achetez le Xiaomi Redmi Note 13 Pro au meilleur prix en Tunisie.
Écouteurs sans fil Xiaomi Redmi Buds 5,xiaomi-redmi-buds-5,119.00,,backorder,Xiaomi,6941812749388,M2316E1,Audio / Écouteurs,https://example.com/images/redmi-buds-5.jpg,,Écouteurs Bluetooth à réduction de bruit et 38 h d'autonomie.,"Écouteurs sans fil Xiaomi Redmi Buds 5 : réduction de bruit active et autonomie jusqu'à 38 h avec l'étui de charge.",Xiaomi Redmi Buds 5 en Tunisie | Tokyo Store,Écouteurs sans fil Xiaomi Redmi Buds 5 au meilleur prix en Tunisie.
`;
