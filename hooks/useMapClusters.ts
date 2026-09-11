import { useMemo } from 'react';
import Supercluster, { PointFeature } from 'supercluster';
import { Deal, MapRegion } from '../types';
import { isPlottableDeal, isUsableRegion } from '../utils/mapRegion';

export interface DealPointProperties {
  cluster: boolean;
  dealId: string;
  deal: Deal;
}

export type DealPointFeature = PointFeature<DealPointProperties>;

export interface ClusterProperties {
  cluster: boolean;
  cluster_id: number;
  point_count: number;
  point_count_abbreviated: string;
}

export type MapClusterItem =
  | {
      type: 'point';
      id: string;
      latitude: number;
      longitude: number;
      deal: Deal;
    }
  | {
      type: 'cluster';
      id: string;
      latitude: number;
      longitude: number;
      pointCount: number;
    };

const MIN_ZOOM = 0;
const MAX_ZOOM = 20;

/**
 * How much ground outside the viewport is still clustered, as a fraction of the
 * viewport's own span on each side. 0.5 keeps a full extra screen of slack in
 * every direction.
 *
 * The bounding box is not only a display filter. Anything it drops is a marker
 * React unmounts, and unmounting a marker whose Android info window is open is
 * one of the documented ways react-native-maps takes the process down. Google
 * Maps pans the camera itself when a marker near an edge is tapped — so with a
 * box drawn exactly at the viewport edge, the act of opening one callout could
 * evict its neighbours, and the next tap landed on a marker mid-teardown. The
 * slack means ordinary panning and tapping no longer changes the marker set at
 * all. It costs nothing: the fetch already bounds this array to roughly one
 * viewport's worth of deals, so the padding usually adds no points.
 */
const BBOX_PADDING = 0.5;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

function regionToZoom(region: MapRegion): number {
  const zoom = Math.round(Math.log2(360 / region.longitudeDelta));
  // `longitudeDelta` arrives from the native map. A zero or a rounding artifact
  // produces ±Infinity here, and supercluster indexes its tree array with it.
  return Number.isFinite(zoom) ? clamp(zoom, MIN_ZOOM, MAX_ZOOM) : MIN_ZOOM;
}

export function useMapClusters(deals: Deal[], region: MapRegion): MapClusterItem[] {
  // A deal with a NaN or out-of-range coordinate cannot be drawn, and handing
  // one to `<Marker coordinate={...}>` is a native crash rather than a missing
  // pin. Screened once here so neither supercluster nor the map ever sees one.
  const plottableDeals = useMemo(() => deals.filter(isPlottableDeal), [deals]);

  const supercluster = useMemo(() => {
    const cluster = new Supercluster<DealPointProperties>({
      radius: 45,
      maxZoom: 16,
    });

    const points: DealPointFeature[] = plottableDeals.map((deal) => ({
      type: 'Feature',
      properties: {
        cluster: false,
        dealId: deal.id,
        deal,
      },
      geometry: {
        type: 'Point',
        coordinates: [deal.longitude, deal.latitude],
      },
    }));

    cluster.load(points);
    return cluster;
  }, [plottableDeals]);

  const clusters = useMemo(() => {
    if (!isUsableRegion(region) || !plottableDeals.length) return [];

    const halfLat = region.latitudeDelta * (0.5 + BBOX_PADDING);
    const halfLng = region.longitudeDelta * (0.5 + BBOX_PADDING);

    const bbox: [number, number, number, number] = [
      clamp(region.longitude - halfLng, -180, 180),
      clamp(region.latitude - halfLat, -90, 90),
      clamp(region.longitude + halfLng, -180, 180),
      clamp(region.latitude + halfLat, -90, 90),
    ];

    const zoom = regionToZoom(region);
    const rawClusters = supercluster.getClusters(bbox, zoom);

    return rawClusters.map((feature): MapClusterItem => {
      const [longitude, latitude] = feature.geometry.coordinates;

      if (feature.properties.cluster) {
        const clusterProps = feature.properties as ClusterProperties;
        return {
          type: 'cluster',
          id: `cluster-${clusterProps.cluster_id}`,
          latitude,
          longitude,
          pointCount: clusterProps.point_count,
        };
      }

      const pointProps = feature.properties as DealPointProperties;
      return {
        type: 'point',
        id: pointProps.dealId,
        latitude,
        longitude,
        deal: pointProps.deal,
      };
    });
  }, [supercluster, region, plottableDeals]);

  return clusters;
}
