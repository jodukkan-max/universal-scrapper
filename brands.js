/* Brand catalog — lightweight subset for the side panel.
 * Keeps the panel from parsing the full 283 KB scrapers bundle just to list brands.
 * Mirror of the BRANDS array in scrapers.js (ready = scraper implemented).
 */
(function (root) {
  'use strict';

  const BRANDS = [
    { name: 'NYX Professional Makeup', domain: 'nyxcosmetics.com', key: 'nyx', ready: true, example: 'https://www.nyxcosmetics.com/lip/lip-gloss-pouch/USNYX_44.html' },
    { name: 'e.l.f. Cosmetics', domain: 'elfcosmetics.com', key: 'elf', ready: true, example: 'https://www.elfcosmetics.com/products/smoky-kohl-eyeliner?Color=Black+Velvet' },
    { name: 'Huda Beauty', domain: 'hudabeauty.com', key: 'huda', ready: true, example: 'https://hudabeauty.com/en-jo/products/easy-blur-natural-airbrush-foundation-with-niacinamide-hb01166m?variant=50573350273302' },
    { name: 'Pastel', domain: 'pastelarabia.com', key: 'pastel', ready: true, example: 'https://pastelarabia.com/collections/foundation/products/silky-dream-foundation' },
    { name: 'Glow Recipe', domain: 'glowrecipe.com', key: 'glowrecipe', ready: true, example: 'https://www.glowrecipe.com/products/watermelon-glow-niacinamide-dew-drops' },
    { name: 'Inglot', domain: 'inglotcosmetics.com', key: 'inglot', ready: true, example: 'https://inglotcosmetics.com/en/eyeliners/99-amc-eyeliner-gel' },
    { name: 'Maybelline', domain: 'maybelline.com', key: 'maybelline', ready: true, example: 'https://www.maybelline.com/face-makeup/foundation-makeup/fit-me-matte-poreless-foundation?variant=334' },
    { name: 'Maybelline SA', domain: 'maybelline.co.za', key: 'maybellineza', ready: true, example: 'https://www.maybelline.co.za/face-makeup/foundation/fit-me-matte-poreless-foundation' },
    { name: 'Flormar', domain: 'flormar.com', key: 'flormar', ready: true, example: 'https://www.flormar.com/perfect-coverage-liquid-concealer--ivory-002/' },
    { name: "L'Oréal Paris", domain: 'lorealparisusa.com', key: 'lorealparis', ready: true, example: 'https://www.lorealparisusa.com/makeup/face/concealer/true-match-radiant-serum-concealer' },
    { name: 'My Loreal Paris', domain: 'lorealparis.com.my', key: 'mylorealparis', ready: true, example: 'https://www.lorealparis.com.my/infallible/infallible-32h-freshwear-foundation-330' },
    { name: 'Vichy', domain: 'vichy-me.com', key: 'vichy', ready: true, example: 'https://www.vichy-me.com/en-ae/all-products/skincare/face-serums/dryness/mineral-89-booster' },
    { name: 'La Roche-Posay', domain: 'laroche-posay.us', key: 'larocheposay', ready: true, example: 'https://www.laroche-posay.us/our-products/sun/face-sunscreen/anthelios-uv-correct-face-sunscreen-spf-70-with-niacinamide-3606000591035.html' },
    { name: 'Urban Care', domain: 'urbancare.ro', key: 'urbancare', ready: true, example: 'https://urbancare.ro/en/product/biotin-keratin-hair-care-shampoo/' },
    { name: 'Urban Care TR', domain: 'urbancare.com.tr', key: 'urbancaretr', ready: true, example: 'https://urbancare.com.tr/argan-oil-keratin-sac-bakim-kremi-250-ml' },
    { name: 'Urban Care CL', domain: 'cliqat.com', key: 'urbancarecl', ready: true, example: 'https://www.cliqat.com/products/urban-care-coconut-coffee-body-wash-500ml' },
    { name: 'Urban Care S', domain: 'makeupstore.com', key: 'urbancares', ready: true, example: 'https://makeupstore.com/product/761377/' },
    { name: 'Bielenda', domain: 'bielenda.pl', key: 'bielenda', ready: true, example: 'https://bielenda.pl/en/catalog/firming-peptides/1452-firming-peptides-cream-70' },
    { name: 'Sephora', domain: 'sephora.com', key: 'sephora', ready: true, example: 'https://www.sephora.com/product/tinted-moisturizer-oil-free-blurred-matte-spf-30-P515711?skuId=2854479&icid2=products%20grid:p515711:product' },
    { name: 'CeraVe', domain: 'cerave.com', key: 'cerave', ready: true, example: 'https://www.cerave.com/skincare/moisturizers/moisturizing-cream' },
    { name: 'NARS', domain: 'narscosmetics.com', key: 'nars', ready: true, example: 'https://www.narscosmetics.com/USA/natural-matte-longwear-foundation/999NAC0000285.html?dwvar_999NAC0000285_color=4251155135&cgid=foundation' },
    { name: 'Seventeen Cosmetics', domain: 'seventeencosmetics.com', key: 'seventeen', ready: true, example: 'https://seventeencosmetics.com/en/catalogue/skin-perfect-ultra-coverage-waterproof-foundation_23/?vid=24#All' },
    { name: 'Radiant Professional', domain: 'radiant-professional.com', key: 'radiant', ready: true, example: 'https://radiant-professional.com/en/catalogue/NATURAL_FIX_CONCEALER_670/' },
    { name: 'Misslyn Cosmetics', domain: 'misslyn.com', key: 'misslyn', ready: true, example: 'https://www.misslyn.com/products/made-to-stay-foundation-water-resistant-foundation' },
    { name: 'essence makeup', domain: 'essencemakeup.com', key: 'essence', ready: true, example: 'https://essencemakeup.com/collections/face/products/correct-conceal-under-eye-brightening-concealer' },
    { name: 'Charlotte Tilbury', domain: 'charlottetilbury.com', key: 'charlottetilbury', ready: true, example: 'https://www.charlottetilbury.com/uk/product/airbrush-flawless-foundation-shade-1-cool?from_multi_product_card=true' },
    { name: 'Dior Makeup', domain: 'dior.com', key: 'dior', ready: true, url: 'https://www.dior.com/en_int/beauty', example: 'https://www.dior.com/en_int/beauty/products/dior-forever-skin-correct-Y0326000.html' },
    { name: 'Summer Fridays', domain: 'summerfridays.com', key: 'summerfridays', ready: true, example: 'https://summerfridays.com/products/jet-lag-mask' },
    { name: 'Character Cosmetics', domain: 'charactercosmetics.in', key: 'character', ready: true, example: 'https://charactercosmetics.in/products/character-hyaluronic-acid-high-coverage-foundation' },
    { name: 'IsaDora', domain: 'isadora.com', key: 'isadora', ready: true, example: 'https://www.isadora.com/products/face/powder/the-no-compromise-matte-longwear-powder/60-neutral-porcelain' },
    { name: 'Topface', domain: 'topfaceofficial.com', key: 'topface', ready: true, example: 'https://topfaceofficial.com/products/aqua-tint-lip-cheek' },
    { name: 'MakeOver', domain: 'makeoverparis.com', key: 'makeover', ready: true, example: 'http://makeoverparis.com/en/products.asp?id1=1&id2=8&id3=32' },
    { name: 'Clamanti', domain: 'clamanti.co.uk', key: 'clamanti', ready: true, example: 'https://clamanti.co.uk/bielenda-neuro-retinol-advanced-moisturizing-face-serum-30-ml.html' },
    { name: 'laCabine', domain: 'lacabine.es', key: 'lacabine', ready: true, example: 'https://lacabine.es/en/productos/364-hydranad-biphase-makeup-remover.html' },
    { name: 'Bruno Vassari', domain: 'brunovassari.com', key: 'brunovassari', ready: true, example: 'https://brunovassari.com/en-row/products/balance-fluid' },
    { name: 'Beesline', domain: 'beesline.com', key: 'beesline', ready: true, example: 'https://beesline.com/en-jo/products/propolis-facial-wash' },
    { name: 'Dermaliscio', domain: 'dermaliscio.net', key: 'dermaliscio', ready: true, example: 'https://dermaliscio.net/product/hyaluronic-acid-anti-wrinkles-lifting-cream-15000-p-p-m-dermaliscio-shade-50-sunscreen/' },
    { name: 'Babaria', domain: 'babaria.es', key: 'babaria', ready: true, example: 'https://babaria.es/en/producto/face-serum-collagen/' },
    { name: 'Sarah K', domain: 'sarahk.com.br', key: 'sarahk', ready: true, example: 'https://www.sarahk.com.br/produto/condicionador-basic-care-3600ml-2' },
    { name: 'Sarah K International', domain: 'sarahkinternational.com', key: 'sarahkintl', ready: true, example: 'https://sarahkinternational.com/product/acondicionador-treatment/' },
    { name: 'Sarah K Store', domain: 'sarahkstore.com', key: 'sarahkstore', ready: true, example: 'https://sarahkstore.com/product/blends-bb-cream-250ml/' },
    { name: 'Shea Miracles', domain: 'sheamiracles.com', key: 'sheamiracles', ready: true, example: 'https://sheamiracles.com/shea-hair-conditioner-300ml-1.html' },
    { name: 'Skala Brasil', domain: 'skalabrasil.com', key: 'skalabrasil', ready: true, example: 'https://skalabrasil.com/en/product/amido-de-milho-573' },
    { name: 'Skinarte', domain: 'dermoconcept.pl', key: 'skinarte', ready: true, example: 'https://dermoconcept.pl/kremy-zele-do-twarzy/14865-skinarte-resurfacing-smoothsebcontrol-cream-50ml-5902169052980.html' },
    { name: 'Beauty Box', domain: 'beautyboxjo.com', key: 'beautybox', ready: true, example: 'https://beautyboxjo.com/products/makeover-sheer-bronzing-powder' },
    { name: 'SVR 1', domain: 'easypara.com', key: 'svr1', ready: true, example: 'https://www.easypara.com/easy-stick-spf50-10ml-sun-secure-svr.html' },
    { name: 'Olaplex', domain: 'olaplex.com', key: 'olaplex', ready: true, example: 'https://olaplex.com/products/n-3plus-complete-repair-treatment' },
    { name: 'Diego dalla Palma', domain: 'diegodallapalma.com', key: 'diegodallapalma', ready: true, example: 'https://diegodallapalma.com/en/products/matita-sopracciglia-alta-precisione-resistente-all-acqua-lunga-tenuta-df12001-master' },
    { name: 'Eucerin', domain: 'eucerin-me.com', key: 'eucerin', ready: true, example: 'https://www.en.eucerin-me.com/products/dermopure-clinical/scrub' },
    { name: 'ISDIN', domain: 'isdin.com', key: 'isdin', ready: true, example: 'https://www.isdin.com/en-AE/product/isdinceutics/age-reverse-night' },
    { name: 'Bioderma', domain: 'bioderma.ae', key: 'bioderma', ready: true, example: 'https://www.bioderma.ae/our-products/atoderm/creme' },
    { name: 'Isispharma', domain: 'isispharma.com', key: 'isispharma', ready: true, example: 'https://www.isispharma.com/en/product/ato-balm/' },
    { name: 'ACM Laboratoire', domain: 'labo-acm.com', key: 'acm', ready: true, example: 'https://labo-acm.com/en/products/shine-reducing-skincare' },
    { name: 'Uriage Eau Thermale', domain: 'uriage.com', key: 'uriage', ready: true, example: 'https://www.uriage.com/MT/en/products/unctuous-body-balm' },
    { name: 'Filorga Laboratoires Paris', domain: 'filorga.com', key: 'filorga', ready: true, example: 'https://int.filorga.com/products/ncef-revitalize-creme' },
    { name: 'Seba Med', domain: 'sebamed.com', key: 'sebamed', ready: true, example: 'https://sebamed.com/en/p/antibacterial-cleansing-foam/' },
    { name: 'Creme 21', domain: 'al-dawaa.com', key: 'creme21', ready: true, example: 'https://www.al-dawaa.com/en/p/209943/creame-21-body-lotion-ultra-dry-skin-almond-oil-600-ml' },
    { name: 'Macadamia Hair', domain: 'macadamiahair.com', key: 'macadamiahair', ready: true, example: 'https://www.macadamiahair.com/products/healing-oil-spray' },
    { name: 'Cantu Shea Beauty', domain: 'cantubeauty.com', key: 'cantubeauty', ready: true, example: 'https://www.cantubeauty.com/products/curls-coils-waves/coconut-curling-cream/' },
    { name: 'Taj Class', domain: 'tajclass.com', key: 'tajclass', ready: true, example: 'https://tajclass.com/products/mascara-i-love-extreme-crazy-volume-essence' },
    { name: 'Makeover Pakistan', domain: 'makeoverpakistan.com', key: 'makeoverpakistan', ready: true, example: 'https://www.makeoverpakistan.com/shop/high-perfection-foundation' },
    { name: 'Care To Beauty', domain: 'caretobeauty.com', key: 'caretobeauty', ready: true, example: 'https://www.caretobeauty.com/jo/bell-hypoallergenic-soft-cream-concealer-02-vanilla-5-5g/' },
    { name: 'Notino', domain: 'notino.co.uk', key: 'notino', ready: true, example: 'https://www.notino.co.uk/mac-cosmetics/macximal-sleek-satin-lipstick-mini-satin-lipstick-for-the-perfect-look/' },
    { name: 'Dumyah', domain: 'dumyah.com', key: 'dumyah', ready: true, example: 'https://www.dumyah.com/en/beauty/hair-body-amp-skin-care/facial-care/natural-glow-facial-moisturizing-cream' },
    { name: 'Semsem', domain: 'semsem.me', key: 'semsem', ready: true, example: 'https://semsem.me/jo_en/nem-collagen-natural-eggshell-membrane-capsule-30-caps.html' },
    { name: 'Galaxus', domain: 'galaxus.ch', key: 'galaxus', ready: true, example: 'https://www.galaxus.ch/de/s6/product/avene-dermabsolu-serum-30-ml-gesichtsserum-49739066' },
    { name: 'Carrefour', domain: 'carrefouruae.com', key: 'carrefour', ready: true, example: 'https://www.carrefouruae.com/mafuae/en/foundations/l-oreal-inf-liq-fou-0130-beige/p/1159838' },
    { name: 'Enzo', domain: 'enzoitaly.com', key: 'enzo', ready: true, example: 'https://www.enzoitaly.com/' },
    { name: 'Celenes', domain: 'celenesbysweden.com', key: 'celenes', ready: true, example: 'https://int.celenesbysweden.com/products/thermal-daily-care-gel-cream' },
    { name: 'Everymarket', domain: 'everymarket.com', key: 'everymarket', ready: true, example: 'https://everymarket.com/products/elf-cosmetics-moisturizing-lipstick-provides-vibrant-color-and-luminous-shine-flirty-and-fabulous' },
    { name: 'Clara', domain: 'musejo.com', key: 'clara', ready: true, example: 'https://musejo.com/products/clara-line-nail-polish' },
  ];

  // Scraper capability per brand. Brands not listed here support both types.
  const VARIABLE_ONLY = new Set(['clara', 'glowrecipe', 'larocheposay', 'maybelline', 'makeoverpakistan', 'maybellineza', 'mylorealparis', 'vichy']);
  const SIMPLE_ONLY = new Set(['acm', 'babaria', 'beautybox', 'beesline', 'bielenda', 'bioderma', 'brunovassari', 'cantubeauty', 'carrefour', 'celenes', 'cerave', 'clamanti', 'creme21', 'dermaliscio', 'dumyah', 'enzo', 'eucerin', 'everymarket', 'filorga', 'galaxus', 'isdin', 'isispharma', 'lacabine', 'sarahk', 'sarahkintl', 'sarahkstore', 'sebamed', 'semsem', 'sheamiracles', 'skalabrasil', 'skinarte', 'svr1', 'tajclass', 'urbancare', 'urbancarecl', 'urbancares', 'urbancaretr', 'uriage']);

  const brands = BRANDS.map(b => ({
    ...b,
    types: VARIABLE_ONLY.has(b.key) ? ['variable']
      : SIMPLE_ONLY.has(b.key) ? ['simple']
      : ['simple', 'variable'],
  }));

  root.BrandCatalog = { brands };
})(typeof self !== 'undefined' ? self : this);
