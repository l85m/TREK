import React, { useEffect, useRef, useState } from 'react'
import { MapContainer, TileLayer, Marker, Tooltip, Polyline, useMap } from 'react-leaflet'
import MarkerClusterGroup from 'react-leaflet-cluster'
import L from 'leaflet'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import 'leaflet.markercluster/dist/MarkerCluster.Default.css'
import { mapsApi } from '../../api/client'
import { getCategoryIcon } from '../shared/categoryIcons'

// Fix default marker icons for vite
delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
})

/**
 * Create a round photo-circle marker.
 * Shows image_url if available, otherwise category icon in colored circle.
 */
function escAttr(s) {
  if (!s) return ''
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function createPlaceIcon(place, orderNumber, isSelected) {
  const size = isSelected ? 44 : 36
  const borderColor = isSelected ? '#111827' : 'white'
  const borderWidth = isSelected ? 3 : 2.5
  const shadow = isSelected
    ? '0 0 0 3px rgba(17,24,39,0.25), 0 4px 14px rgba(0,0,0,0.3)'
    : '0 2px 8px rgba(0,0,0,0.22)'
  const bgColor = place.category_color || '#6b7280'
  const icon = place.category_icon || '📍'

  // White semi-transparent number badge (bottom-right), only when orderNumber is set
  const badgeHtml = orderNumber != null ? `
    <span style="
      position:absolute;bottom:-3px;right:-3px;
      min-width:18px;height:18px;border-radius:9px;
      padding:0 3px;
      background:rgba(255,255,255,0.92);
      border:1.5px solid rgba(0,0,0,0.18);
      box-shadow:0 1px 4px rgba(0,0,0,0.18);
      display:flex;align-items:center;justify-content:center;
      font-size:9px;font-weight:800;color:#111827;
      font-family:-apple-system,system-ui,sans-serif;line-height:1;
      box-sizing:border-box;
    ">${orderNumber}</span>` : ''

  if (place.image_url) {
    return L.divIcon({
      className: '',
      html: `<div style="
        width:${size}px;height:${size}px;border-radius:50%;
        border:${borderWidth}px solid ${borderColor};
        box-shadow:${shadow};
        overflow:visible;background:${bgColor};
        cursor:pointer;flex-shrink:0;position:relative;
      ">
        <div style="width:100%;height:100%;border-radius:50%;overflow:hidden;">
          <img src="${escAttr(place.image_url)}" style="width:100%;height:100%;object-fit:cover;" />
        </div>
        ${badgeHtml}
      </div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      tooltipAnchor: [size / 2 + 6, 0],
    })
  }

  return L.divIcon({
    className: '',
    html: `<div style="
      width:${size}px;height:${size}px;border-radius:50%;
      border:${borderWidth}px solid ${borderColor};
      box-shadow:${shadow};
      background:${bgColor};
      display:flex;align-items:center;justify-content:center;
      cursor:pointer;position:relative;
    ">
      <span style="font-size:${isSelected ? 18 : 15}px;line-height:1;">${icon}</span>
      ${badgeHtml}
    </div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    tooltipAnchor: [size / 2 + 6, 0],
  })
}

function SelectionController({ places, selectedPlaceId }) {
  const map = useMap()
  const prev = useRef(null)

  useEffect(() => {
    if (selectedPlaceId && selectedPlaceId !== prev.current) {
      const place = places.find(p => p.id === selectedPlaceId)
      if (place?.lat && place?.lng) {
        map.setView([place.lat, place.lng], Math.max(map.getZoom(), 15), { animate: true, duration: 0.5 })
      }
    }
    prev.current = selectedPlaceId
  }, [selectedPlaceId, places, map])

  return null
}

function MapController({ center, zoom }) {
  const map = useMap()
  const prevCenter = useRef(center)

  useEffect(() => {
    if (prevCenter.current[0] !== center[0] || prevCenter.current[1] !== center[1]) {
      map.setView(center, zoom)
      prevCenter.current = center
    }
  }, [center, zoom, map])

  return null
}

// Fit bounds when places change (fitKey triggers re-fit)
function BoundsController({ places, fitKey }) {
  const map = useMap()
  const prevFitKey = useRef(-1)

  useEffect(() => {
    if (fitKey === prevFitKey.current) return
    prevFitKey.current = fitKey
    if (places.length === 0) return
    try {
      const bounds = L.latLngBounds(places.map(p => [p.lat, p.lng]))
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [60, 60], maxZoom: 15, animate: true })
    } catch {}
  }, [fitKey, places, map])

  return null
}

function MapClickHandler({ onClick }) {
  const map = useMap()
  useEffect(() => {
    if (!onClick) return
    map.on('click', onClick)
    return () => map.off('click', onClick)
  }, [map, onClick])
  return null
}

// Module-level photo cache shared with PlaceAvatar
const mapPhotoCache = new Map()

export function MapView({
  places = [],
  route = null,
  selectedPlaceId = null,
  onMarkerClick,
  onMapClick,
  center = [48.8566, 2.3522],
  zoom = 10,
  tileUrl = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  fitKey = 0,
  dayOrderMap = {},
}) {
  const [photoUrls, setPhotoUrls] = useState({})

  // Fetch Google photos for places that have google_place_id but no image_url
  useEffect(() => {
    places.forEach(place => {
      if (place.image_url || !place.google_place_id) return
      if (mapPhotoCache.has(place.google_place_id)) {
        const cached = mapPhotoCache.get(place.google_place_id)
        if (cached) setPhotoUrls(prev => ({ ...prev, [place.google_place_id]: cached }))
        return
      }
      mapsApi.placePhoto(place.google_place_id)
        .then(data => {
          if (data.photoUrl) {
            mapPhotoCache.set(place.google_place_id, data.photoUrl)
            setPhotoUrls(prev => ({ ...prev, [place.google_place_id]: data.photoUrl }))
          }
        })
        .catch(() => { mapPhotoCache.set(place.google_place_id, null) })
    })
  }, [places])

  return (
    <MapContainer
      center={center}
      zoom={zoom}
      zoomControl={false}
      className="w-full h-full"
      style={{ background: '#e5e7eb' }}
    >
      <TileLayer
        url={tileUrl}
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        maxZoom={19}
      />

      <MapController center={center} zoom={zoom} />
      <BoundsController places={places} fitKey={fitKey} />
      <SelectionController places={places} selectedPlaceId={selectedPlaceId} />
      <MapClickHandler onClick={onMapClick} />

      <MarkerClusterGroup
        chunkedLoading
        maxClusterRadius={30}
        disableClusteringAtZoom={11}
        spiderfyOnMaxZoom
        showCoverageOnHover={false}
        zoomToBoundsOnClick
        iconCreateFunction={(cluster) => {
          const count = cluster.getChildCount()
          const size = count < 10 ? 36 : count < 50 ? 42 : 48
          return L.divIcon({
            html: `<div class="marker-cluster-custom"
              style="width:${size}px;height:${size}px;">
              <span>${count}</span>
            </div>`,
            className: 'marker-cluster-wrapper',
            iconSize: L.point(size, size),
          })
        }}
      >
        {places.map((place) => {
          const isSelected = place.id === selectedPlaceId
          const resolvedPhotoUrl = place.image_url || (place.google_place_id && photoUrls[place.google_place_id]) || null
          const orderNumber = dayOrderMap[place.id] ?? null
          const icon = createPlaceIcon({ ...place, image_url: resolvedPhotoUrl }, orderNumber, isSelected)

          return (
            <Marker
              key={place.id}
              position={[place.lat, place.lng]}
              icon={icon}
              eventHandlers={{
                click: () => onMarkerClick && onMarkerClick(place.id),
              }}
              zIndexOffset={isSelected ? 1000 : 0}
            >
              <Tooltip
                direction="right"
                offset={[0, 0]}
                opacity={1}
                className="map-tooltip"
              >
                <div style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif" }}>
                  <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>
                    {place.name}
                  </div>
                  {place.category_name && (() => {
                    const CatIcon = getCategoryIcon(place.category_icon)
                    return (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginTop: 1 }}>
                        <CatIcon size={10} style={{ color: place.category_color || 'var(--text-muted)', flexShrink: 0 }} />
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{place.category_name}</span>
                      </div>
                    )
                  })()}
                  {place.address && (
                    <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 2, maxWidth: 180, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {place.address}
                    </div>
                  )}
                </div>
              </Tooltip>
            </Marker>
          )
        })}
      </MarkerClusterGroup>

      {route && route.length > 1 && (
        <Polyline
          positions={route}
          color="#111827"
          weight={3}
          opacity={0.9}
          dashArray="6, 5"
        />
      )}
    </MapContainer>
  )
}
