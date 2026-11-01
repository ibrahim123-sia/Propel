/**
 * MapLibre with its stylesheet, loaded together only when a map is about to show. Imported
 * statically, the 80 KB stylesheet blocked the first paint of every page with a map.
 */
import "maplibre-gl/dist/maplibre-gl.css";

export * from "maplibre-gl";
