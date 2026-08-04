// The racer is no longer hardwired to countries. A "category" is a pool of
// racer items (countries, US states, colours, fruits, vegetables); a race picks
// 10 at random from the chosen category. This is what lets the game double as a
// way to teach kids categories - the marbles become flags, fruit, veg, colours.
import { COUNTRIES } from "./countries";
import { STATES } from "./states";

// A single racer's identity + how to skin its marble. Exactly one texture source
// is set: `img` (a PNG url, e.g. a flag), `emoji` (a glyph), or `color` (solid).
export type RacerItem = {
  id: string;
  name: string;
  hue: number; // marble glow / health-bar accent (0-359)
  img?: string;
  emoji?: string;
  color?: string;
};

export type Category = { id: string; label: string; icon: string; items: RacerItem[] };

// Deterministic spread of accent hues for a list that has no hue of its own.
const hueAt = (i: number) => (i * 53 + 17) % 360;

const COLORS: RacerItem[] = [
  { id: "red", name: "Red", hue: 0, color: "#e23b3b" },
  { id: "orange", name: "Orange", hue: 28, color: "#f28c1e" },
  { id: "yellow", name: "Yellow", hue: 50, color: "#f4d02b" },
  { id: "green", name: "Green", hue: 130, color: "#35b45a" },
  { id: "teal", name: "Teal", hue: 175, color: "#1fb6a6" },
  { id: "blue", name: "Blue", hue: 215, color: "#2f6fe0" },
  { id: "purple", name: "Purple", hue: 270, color: "#8a4fe0" },
  { id: "pink", name: "Pink", hue: 330, color: "#e85aa8" },
  { id: "brown", name: "Brown", hue: 25, color: "#8a5a2e" },
  { id: "black", name: "Black", hue: 240, color: "#2a2d34" },
  { id: "white", name: "White", hue: 210, color: "#e9edf2" },
  { id: "gray", name: "Gray", hue: 210, color: "#8a929c" },
];

const FRUITS: RacerItem[] = [
  { id: "apple", name: "Apple", hue: 5, emoji: "🍎" },
  { id: "banana", name: "Banana", hue: 48, emoji: "🍌" },
  { id: "grapes", name: "Grapes", hue: 275, emoji: "🍇" },
  { id: "orange", name: "Orange", hue: 30, emoji: "🍊" },
  { id: "strawberry", name: "Strawberry", hue: 350, emoji: "🍓" },
  { id: "watermelon", name: "Watermelon", hue: 140, emoji: "🍉" },
  { id: "peach", name: "Peach", hue: 20, emoji: "🍑" },
  { id: "pineapple", name: "Pineapple", hue: 48, emoji: "🍍" },
  { id: "cherries", name: "Cherries", hue: 350, emoji: "🍒" },
  { id: "lemon", name: "Lemon", hue: 52, emoji: "🍋" },
  { id: "kiwi", name: "Kiwi", hue: 90, emoji: "🥝" },
  { id: "mango", name: "Mango", hue: 35, emoji: "🥭" },
  { id: "pear", name: "Pear", hue: 80, emoji: "🍐" },
  { id: "coconut", name: "Coconut", hue: 30, emoji: "🥥" },
];

const VEGGIES: RacerItem[] = [
  { id: "carrot", name: "Carrot", hue: 28, emoji: "🥕" },
  { id: "broccoli", name: "Broccoli", hue: 120, emoji: "🥦" },
  { id: "corn", name: "Corn", hue: 50, emoji: "🌽" },
  { id: "potato", name: "Potato", hue: 35, emoji: "🥔" },
  { id: "tomato", name: "Tomato", hue: 6, emoji: "🍅" },
  { id: "eggplant", name: "Eggplant", hue: 275, emoji: "🍆" },
  { id: "pepper", name: "Pepper", hue: 130, emoji: "🫑" },
  { id: "cucumber", name: "Cucumber", hue: 110, emoji: "🥒" },
  { id: "onion", name: "Onion", hue: 40, emoji: "🧅" },
  { id: "garlic", name: "Garlic", hue: 40, emoji: "🧄" },
  { id: "peas", name: "Peas", hue: 100, emoji: "🫛" },
  { id: "lettuce", name: "Lettuce", hue: 100, emoji: "🥬" },
  { id: "avocado", name: "Avocado", hue: 80, emoji: "🥑" },
  { id: "sweetpotato", name: "Sweet Potato", hue: 25, emoji: "🍠" },
];

export const CATEGORIES: Category[] = [
  {
    id: "countries",
    label: "Countries",
    icon: "🏳️",
    items: COUNTRIES.map((c) => ({ id: c.code, name: c.name, hue: c.hue, img: `/flags/${c.code}.png` })),
  },
  {
    id: "states",
    label: "US States",
    icon: "🇺🇸",
    items: STATES.map((s, i) => ({ id: s.abbr, name: s.name, hue: hueAt(i), img: `/states/${s.abbr}.png` })),
  },
  { id: "colors", label: "Colors", icon: "🎨", items: COLORS },
  { id: "fruits", label: "Fruits", icon: "🍎", items: FRUITS },
  { id: "veggies", label: "Vegetables", icon: "🥕", items: VEGGIES },
];
