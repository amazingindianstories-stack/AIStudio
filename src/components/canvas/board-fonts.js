/**
 * The board font library (src/lib/canvas/fonts.js), self-hosted through
 * next/font. Nothing is preloaded: each font only declares its @font-face and
 * CSS variable (set on the root element in src/app/layout.jsx, so menus
 * portaled outside the board see them too), so a browser downloads a font (and only the scripts it needs)
 * once an object on the board uses it.
 */
import {
  Caveat,
  Comfortaa,
  EB_Garamond,
  Exo_2,
  Fira_Sans,
  IBM_Plex_Mono,
  IBM_Plex_Sans,
  Inter,
  JetBrains_Mono,
  Lobster,
  Lora,
  Manrope,
  Merriweather,
  Montserrat,
  Noto_Sans,
  Noto_Sans_JP,
  Noto_Sans_KR,
  Noto_Sans_SC,
  Noto_Sans_TC,
  Noto_Serif,
  Nunito,
  Open_Sans,
  Oswald,
  PT_Sans,
  PT_Serif,
  Pacifico,
  Playfair_Display,
  Raleway,
  Roboto,
  Roboto_Mono,
  Roboto_Slab,
  Rubik,
  Source_Sans_3,
  Ubuntu,
} from "next/font/google";

const inter = Inter({ display: "swap", preload: false, variable: "--board-font-inter" });
const roboto = Roboto({ display: "swap", preload: false, variable: "--board-font-roboto" });
const openSans = Open_Sans({ display: "swap", preload: false, variable: "--board-font-open-sans" });
const montserrat = Montserrat({ display: "swap", preload: false, variable: "--board-font-montserrat" });
const notoSans = Noto_Sans({ display: "swap", preload: false, variable: "--board-font-noto-sans" });
const ptSans = PT_Sans({ weight: ["400", "700"], display: "swap", preload: false, variable: "--board-font-pt-sans" });
const firaSans = Fira_Sans({ weight: ["400", "700"], display: "swap", preload: false, variable: "--board-font-fira-sans" });
const rubik = Rubik({ display: "swap", preload: false, variable: "--board-font-rubik" });
const raleway = Raleway({ display: "swap", preload: false, variable: "--board-font-raleway" });
const ubuntu = Ubuntu({ weight: ["400", "700"], display: "swap", preload: false, variable: "--board-font-ubuntu" });
const sourceSans = Source_Sans_3({ display: "swap", preload: false, variable: "--board-font-source-sans" });
const ibmPlexSans = IBM_Plex_Sans({ display: "swap", preload: false, variable: "--board-font-ibm-plex-sans" });
const nunito = Nunito({ display: "swap", preload: false, variable: "--board-font-nunito" });
const manrope = Manrope({ display: "swap", preload: false, variable: "--board-font-manrope" });
const oswald = Oswald({ display: "swap", preload: false, variable: "--board-font-oswald" });
const exo2 = Exo_2({ display: "swap", preload: false, variable: "--board-font-exo-2" });
const comfortaa = Comfortaa({ display: "swap", preload: false, variable: "--board-font-comfortaa" });
const notoSerif = Noto_Serif({ display: "swap", preload: false, variable: "--board-font-noto-serif" });
const ptSerif = PT_Serif({ weight: ["400", "700"], display: "swap", preload: false, variable: "--board-font-pt-serif" });
const merriweather = Merriweather({ display: "swap", preload: false, variable: "--board-font-merriweather" });
const lora = Lora({ display: "swap", preload: false, variable: "--board-font-lora" });
const playfair = Playfair_Display({ display: "swap", preload: false, variable: "--board-font-playfair" });
const ebGaramond = EB_Garamond({ display: "swap", preload: false, variable: "--board-font-eb-garamond" });
const robotoSlab = Roboto_Slab({ display: "swap", preload: false, variable: "--board-font-roboto-slab" });
const ibmPlexMono = IBM_Plex_Mono({ weight: ["400", "700"], display: "swap", preload: false, variable: "--board-font-ibm-plex-mono" });
const jetbrainsMono = JetBrains_Mono({ display: "swap", preload: false, variable: "--board-font-jetbrains-mono" });
const robotoMono = Roboto_Mono({ display: "swap", preload: false, variable: "--board-font-roboto-mono" });
const caveat = Caveat({ display: "swap", preload: false, variable: "--board-font-caveat" });
const pacifico = Pacifico({ weight: "400", display: "swap", preload: false, variable: "--board-font-pacifico" });
const lobster = Lobster({ weight: "400", display: "swap", preload: false, variable: "--board-font-lobster" });
const notoSansJp = Noto_Sans_JP({ display: "swap", preload: false, variable: "--board-font-noto-sans-jp" });
const notoSansSc = Noto_Sans_SC({ display: "swap", preload: false, variable: "--board-font-noto-sans-sc" });
const notoSansTc = Noto_Sans_TC({ display: "swap", preload: false, variable: "--board-font-noto-sans-tc" });
const notoSansKr = Noto_Sans_KR({ display: "swap", preload: false, variable: "--board-font-noto-sans-kr" });

/** Class names that define every board font's CSS variable; set on the canvas root. */
export const BOARD_FONT_VARIABLES = [
  inter.variable,
  roboto.variable,
  openSans.variable,
  montserrat.variable,
  notoSans.variable,
  ptSans.variable,
  firaSans.variable,
  rubik.variable,
  raleway.variable,
  ubuntu.variable,
  sourceSans.variable,
  ibmPlexSans.variable,
  nunito.variable,
  manrope.variable,
  oswald.variable,
  exo2.variable,
  comfortaa.variable,
  notoSerif.variable,
  ptSerif.variable,
  merriweather.variable,
  lora.variable,
  playfair.variable,
  ebGaramond.variable,
  robotoSlab.variable,
  ibmPlexMono.variable,
  jetbrainsMono.variable,
  robotoMono.variable,
  caveat.variable,
  pacifico.variable,
  lobster.variable,
  notoSansJp.variable,
  notoSansSc.variable,
  notoSansTc.variable,
  notoSansKr.variable,
].join(" ");
