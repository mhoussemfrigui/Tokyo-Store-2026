/**
 * Downloadable starter templates for the product importer
 * (`/admin/system/import`). Kept as plain string constants so the admin UI
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
        g:price                   prix en dinars, ex. "249.00 TND" (obligatoire)
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
      <g:title>Casio G-SHOCK GA-2100 - Montre Homme</g:title>
      <g:link>https://tokyostore.tn/homme/1001-casio-g-shock-ga-2100-montre-homme-tunisie.html</g:link>
      <g:description><![CDATA[La G-SHOCK GA-2100 « CasiOak » : boîtier carbone ultra-fin, étanchéité 200 m et cadran analogique-numérique.]]></g:description>
      <g:image_link>https://example.com/images/casio-ga-2100-cadran.jpg</g:image_link>
      <g:additional_image_link>https://example.com/images/casio-ga-2100-profil.jpg</g:additional_image_link>
      <g:price>249.00 TND</g:price>
      <g:availability>in_stock</g:availability>
      <g:condition>new</g:condition>
      <g:brand>Casio</g:brand>
      <g:gtin>4549526208461</g:gtin>
      <g:mpn>GA-2100-1A1</g:mpn>
      <g:product_type>Homme</g:product_type>
      <cmp:meta_title>Casio G-SHOCK GA-2100 Homme en Tunisie | Tokyo Store</cmp:meta_title>
      <cmp:meta_description><![CDATA[Achetez la montre Casio G-SHOCK GA-2100 au meilleur prix en Tunisie. Livraison rapide partout.]]></cmp:meta_description>
    </item>
    <item>
      <g:id>1002</g:id>
      <g:title>Festina Boyfriend - Montre Femme</g:title>
      <g:link>https://tokyostore.tn/femme/1002-festina-boyfriend-montre-femme-tunisie.html</g:link>
      <g:description><![CDATA[Montre Festina Boyfriend : boîtier acier doré, cadran nacré et bracelet maille milanaise.]]></g:description>
      <g:image_link>https://example.com/images/festina-boyfriend-cadran.jpg</g:image_link>
      <g:price>349.00 TND</g:price>
      <g:availability>out_of_stock</g:availability>
      <g:condition>new</g:condition>
      <g:brand>Festina</g:brand>
      <g:gtin>8430622753497</g:gtin>
      <g:mpn>F20622/1</g:mpn>
      <g:product_type>Femme</g:product_type>
      <cmp:meta_title>Festina Boyfriend Femme en Tunisie | Tokyo Store</cmp:meta_title>
      <cmp:meta_description><![CDATA[Montre Festina Boyfriend pour femme au meilleur prix en Tunisie.]]></cmp:meta_description>
    </item>
  </channel>
</rss>
`;

export const IMPORT_TEMPLATE_CSV = `name,slug,price_dinars,old_price_dinars,availability,brand,gtin,mpn,category_path,image_url,additional_image_urls,short_desc,description,meta_title,meta_description
Casio G-SHOCK GA-2100 - Montre Homme,casio-g-shock-ga-2100-montre-homme,249.00,299.00,in_stock,Casio,4549526208461,GA-2100-1A1,Homme,https://example.com/images/casio-ga-2100-cadran.jpg,https://example.com/images/casio-ga-2100-profil.jpg|https://example.com/images/casio-ga-2100-bracelet.jpg,La G-SHOCK GA-2100 « CasiOak », étanche 200 m.,"La Casio G-SHOCK GA-2100 « CasiOak » : boîtier carbone ultra-fin, cadran analogique-numérique et étanchéité 200 m.",Casio G-SHOCK GA-2100 Homme en Tunisie | Tokyo Store,Achetez la montre Casio G-SHOCK GA-2100 au meilleur prix en Tunisie.
Bracelet acier maille milanaise 20mm,bracelet-acier-milanaise-20mm,89.00,,backorder,Tokyo Store,0711719582779,BR-MIL-20,Accessoires / Bracelets,https://example.com/images/bracelet-milanaise.jpg,,Bracelet acier maille milanaise interchangeable 20 mm.,"Bracelet de montre en acier inoxydable, maille milanaise, fermoir aimanté et largeur 20 mm — compatible avec la plupart des boîtiers.",Bracelet acier milanaise 20mm | Tokyo Store,Bracelet de montre acier maille milanaise 20 mm au meilleur prix en Tunisie.
`;
