/** @type {import('tailwindcss').Config} */
import nativewindPreset from "nativewind/preset";

export default {
    content: ["./app/**/*.{js,jsx,ts,tsx}", "./components/**/*.{js,jsx,ts,tsx}"],
    theme: {
        extend: {
            colors: {
                "primary": "#FFC107",
                "background-light": "#F5F5F5",
                "background-dark": "#212121",
                "text-light": "#212121",
                "text-dark": "#F5F5F5",
                "text-secondary-light": "#757575",
                "text-secondary-dark": "#BDBDBD",
                "charcoal": "#36454F",
                "off-white": "#F5F5F5",
                "muted-gray": "#A9A9A9",
            },
            fontFamily: {
                "display": ["Plus Jakarta Sans", "sans-serif"]
            },
        },
    },
    plugins: [],
    presets: [nativewindPreset],
}
