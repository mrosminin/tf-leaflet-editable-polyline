L.Polyline.polylineEditor = L.Polyline.extend({
  /**
   * Добавление методов к карте если их еще нет
   */
  _prepareMap: function() {
    const that = this

    that._chain = false // Флаг режима добавления по цепочке. True - идет добавление точек
    that._disabled = false
    that._polygon = null

    if (this._map._editablePolylines) {
      return
    }

    // Контейнер для всех полилиний у текущей карты:
    this._map._editablePolylines = []
    this._map._editablePolylinesEnabled = true

    // Добавление новой полилинии при клике на карте:
    if (this._options.newPolylines) {
      that._map.on("click", function(event) {
        if (that._map.isEditablePolylinesBusy() || that._chain || that._markers.length > 0) {
          return
        }
        if (that._options.newPolylineConfirmMessage) {
          if (!confirm(that._options.newPolylineConfirmMessage)) {
            return
          }
        }

        L.Polyline.PolylineEditor(
          [event.latlng],
          that._options,
          [{ "originalPolylineNo": null, "originalPointNo": null }]
        ).addTo(that._map)
        that._showBoundMarkers()
      })
    }

    /**
     * Проверка есть ли "занятые" полилинии на карте.
     */
    this._map.isEditablePolylinesBusy = function() {
      const map = this
      map._editablePolylines.some(line => line._isBusy())
    }

    /**
     * Включение/выключение редактирования.
     */
    this._map.setEditablePolylinesEnabled = function(enabled) {
      const map = this
      map._editablePolylinesEnabled = enabled
      map._editablePolylines.forEach(line => {
        enabled ? line._showBoundMarkers() : line._hideAll()
      })
    }

    /**
     * Метод для карты, чтобы получить все редактируемые полилинии
     */
    this._map.getEditablePolylines = function() {
      const map = this
      return map._editablePolylines
    }

    /**
     * Метод для карты, чтобы отредактировать позиции маркеров рядом с измененным
     */
    this._map.fixAroundEditablePoint = function(marker) {
      const map = this
      map._editablePolylines.forEach(line => line._reloadPolyline(marker))
    }
  },

  /**
   * Добавление методов к новой полилинии
   */
  _addMethods: function() {
    const that = this

    /**
     * Инициализация полилинии
     * @param options Object
     * @param contexts Array|null
     */
    this._init = function(options, contexts) {
      this._prepareMap()
      this._parseOptions(options)

      /**
       * Все взаимодействия с полилинией основаны на событиях маркеров (pointMarker).
       * Каждый маркер содержит ссылку на свой псевдомаркер (newPointMarker)
       * расположенный перед ним (у первого маркера newPointMarker == null).
       */
      this._markers = []
      let points = that.getLatLngs()
      points.forEach((point, i) => {
        const marker = this._addMarkers(i, point)
        if (!marker.hasOwnProperty("context")) { marker.context = that._contexts ? contexts[i] : {} }
        if (!marker.hasOwnProperty("originalPointNo")) { marker.context.originalPointNo = i }
        if (!marker.hasOwnProperty("originalPolylineNo")) { marker.context.originalPolylineNo = that._map._editablePolylines.length }
      })

      // Map move => show different editable markers:
      this._map.on("zoomend", () => that._showBoundMarkers())
      this._map.on("moveend", () => that._showBoundMarkers())

      var stopHandler = function(event) {
        if (!that._chain) return

        that._chain = false
        if (that._markers.length === 1) {
          that.setPoints([])
        }
        that._emit("leafletPolylineUpdate", event)
        that._reloadPolyline()
      }

      this._map.on("contextmenu", stopHandler)
      this._map.on("mouseout", stopHandler)

      that._map._editablePolylines.push(this)
    }

    /**
     * Проверка идет ли добавление/удаление точек полилинии в данный момент
     */
    this._isBusy = function() {
      return that._busy
    }

    /**
     * Установка состояния добавления/удаление точек для полилинии
     */
    this._setBusy = function(busy) {
      that._busy = busy
    }

    this._setMarkersOnPoints = function() {
      if (that._markers) {
        that._markers.forEach(marker => that._removeMarkers(marker))
      }

      that._markers = []
      // Получаем добаленные ранее точки, как объекты полилинии
      const points = this.getLatLngs()
      const length = points.length

      // Для каждой точки создаем два маркера (основной и на редактирование)
      points.forEach((point, i) => {
        const marker = this._addMarkers(i, point, false)
        if (!marker.hasOwnProperty("context")) {
          marker.context = that._contexts ? that._contexts[i] : {}
        }
        if (!marker.context.hasOwnProperty("originalPointNo")) {
          marker.context.originalPointNo = i
        }
        if (!marker.context.hasOwnProperty("originalPolylineNo")) {
          marker.context.originalPolylineNo = that._map._editablePolylines.length
        }
        if (i === 0) {
          marker.options.icon = that._options.firstPointIcon || that._options.pointIcon
        }
        if (i === length - 1) {
          marker.options.icon = that._options.lastPointIcon || that._options.pointIcon
        }
      })
    }

    this._parseOptions = function(options) {
      options = options || {}

      options.maxMarkers = options.maxMarkers || 100
      options.newPolylines = options.newPolylines || false
      options.newPolylineConfirmMessage = options.newPolylineConfirmMessage || ""
      options.addFirstLastPointEvent = options.addFirstLastPointEvent || "click"
      options.customPointListeners = options.customNewPointListeners || {}
      options.customNewPointListeners = options.customNewPointListeners || {}
      options.newPointOpacity = options.newPointOpacity || 1
      if (!options.hasOwnProperty("chainedAdding")) {
        options.chainedAdding = true
      }
      if (!options.hasOwnProperty("polygonMode")) {
        options.polygonMode = false
      }
      if (!options.hasOwnProperty("noSplit")) {
        options.noSplit = false
      }

      this._options = options
    }

    /**
     * Show only markers in current map bounds *is* there are only a certain
     * number of markers. This method is called on event that change map
     * bounds.
     */
    this._showBoundMarkers = function() {
      if (!that._map) {
        return
      }

      this._setBusy(false)
      if (!that._map._editablePolylinesEnabled) {
        // Do not show because editing is disabled
        return
      }

      const bounds = that._map.getBounds()
      let found = 0
      let pointNo = 0
      let markercopy = {}
      for (let polyline of that._map._editablePolylines) {
        if (polyline._disabled) continue

        polyline._markers.forEach((marker, idx) => {
          if (!marker.hasOwnProperty("context")) {
            marker.context = that._contexts ? that._contexts[idx] : {}
            markercopy = marker
            pointNo = idx
          }
          if (bounds.contains(marker.getLatLng())) { found += 1 }
        })
      }

      if (Object.keys(markercopy).length !== 0) {
        if (!markercopy.context.hasOwnProperty("originalPointNo")) { markercopy.context.originalPointNo = parseInt(pointNo) }
        if (!markercopy.context.hasOwnProperty("originalPolylineNo")) { markercopy.context.originalPolylineNo = that._map._editablePolylines.length }

        that._markers.forEach(function(obj, i) {
          if (i > pointNo) {
            obj.context.originalPointNo = obj.context.originalPointNo + 1
          }
        })
      }

      for (let polyline of that._map._editablePolylines) {
        if (polyline._disabled) continue

        polyline._markers.forEach((marker, idx) => {
          if (found < that._options.maxMarkers) {
            that._setMarkerVisible(marker, bounds.contains(marker.getLatLng()))
            that._setMarkerVisible(marker.newPointMarker, idx > 0 && bounds.contains(marker.getLatLng()))
          } else {
            that._setMarkerVisible(marker, false)
            that._setMarkerVisible(marker.newPointMarker, false)
          }
        })
      }
    }

    /**
     * Used when adding/moving points in order to disable the user to mess
     * with other markers (+ easier to decide where to put the point
     * without too many markers).
     */
    this._hideAll = function(except) {
      this._setBusy(true)
      for (let polyline of that._map._editablePolylines) {
        for (let marker of polyline._markers) {
          if (except == null || except !== marker) { polyline._setMarkerVisible(marker, false) }
          if (except == null || except !== marker.newPointMarker) { polyline._setMarkerVisible(marker.newPointMarker, false) }
        }
      }
    }

    /**
     * Скрывает/показывает маркеры.
     */
    this._setMarkerVisible = function(marker, show) {
      if (!marker) return

      const map = this._map
      if (show) {
        if (!marker._visible) {
          !marker._map
            ? marker.addTo(map) // First show for this marker:
            : map.addLayer(marker) // Marker was already shown and hidden:
          marker._map = map
        }
        marker._visible = true
        return
      }

      if (marker._visible) map.removeLayer(marker)
      marker._visible = false
    }

    /**
     * Перерисовка полилинии
     */
    this._reloadPolyline = function(fixAroundPointNo) {
      let latlngs = that._getMarkerLatLngs()

      // Если работа в режиме полигона, то добавляем замыкающую линию
      if (that._options.polygonMode && latlngs.length > 2) {
        latlngs.push(latlngs[0])
      }

      that.setLatLngs(latlngs)
      if (fixAroundPointNo != null) { that._fixAround(fixAroundPointNo) }
      that._showBoundMarkers(that.getID())
    }

    /**
     * Добавляет маркер точки и связанный с ним псевдомаркер.
     *
     * На карту маркеры добаляются не здесь, функция marker.addTo(map) вызывается позже,
     * когда все маркеры добавлены, в целях улучшения производительности.
     */
    this._addMarkers = function(pointNo, latLng, fixNeighbourPositions) {
      const that = this
      const points = this.getLatLngs()
      const marker = L.marker(latLng, { draggable: true, icon: this._options.pointIcon })

      marker.newPointMarker = null

      marker.on("dragstart", function(event) {
        const pointNo = that._getPointNo(event.target)
        let previousPoint = pointNo && pointNo > 0 ? that._markers[pointNo - 1].getLatLng() : that._markers[that._markers.length - 1].getLatLng()
        let nextPoint = pointNo < that._markers.length - 1 ? that._markers[pointNo + 1].getLatLng() : that._markers[0].getLatLng()
        that._emit("leafletPolylineDragStart", event)

        if (!that._options.polygonMode && pointNo === 0) {
          previousPoint = null
        }
        if (!that._options.polygonMode && pointNo === that._markers.length - 1) {
          nextPoint = null
        }

        that._setupDragLines(marker, previousPoint, nextPoint)
        that._hideAll(marker)
      })

      marker.on("dragend", function(event) {
        var pointNo = that._getPointNo(event.target)
        setTimeout(function() {
          that._reloadPolyline(pointNo)
          that._emit("leafletPolylineDragEnd", event)
        }, 25)
      })

      marker.on("contextmenu", function(event) {
        var marker = event.target
        var pointNo = that._getPointNo(event.target)
        that._map.removeLayer(marker)
        that._map.removeLayer(newPointMarker)
        that._markers.splice(pointNo, 1)
        that._markers.forEach(function(obj, i) {
          if (i >= pointNo) {
            obj.context.originalPointNo = obj.context.originalPointNo - 1
          }
        })
        that._reloadPolyline(pointNo)
        that._emit("leafletPolylineRemovePoint", event)
      })

      marker.on(that._options.addFirstLastPointEvent, function(event) {
        setTimeout(() => {
          var marker = event.target
          var pointNo = that._getPointNo(marker)
          if (+pointNo === 0 || +pointNo === +that._markers.length - 1) {
            that._chain = marker
            that._prepareForNewPoint(marker, pointNo === 0 ? 0 : pointNo + 1)
          }
        }, 50)
      })

      var previousPoint = points[+pointNo === 0 ? pointNo : pointNo - 1]
      var newPointMarker = L.marker(
        [(latLng.lat + previousPoint.lat) / 2.0, (latLng.lng + previousPoint.lng) / 2.0],
        { draggable: true, icon: this._options.newPointIcon, opacity: this._options.newPointOpacity }
      )

      marker.newPointMarker = newPointMarker

      newPointMarker.on("dragstart", function(event) {
        var pointNo = that._getPointNo(event.target)
        var prevPoint = that._markers[pointNo - 1].getLatLng()
        var nextPoint = that._markers[pointNo].getLatLng()
        that._setupDragLines(marker.newPointMarker, prevPoint, nextPoint)
        that._hideAll(marker.newPointMarker)
      })
      newPointMarker.on("dragend", function(event) {
        var marker = event.target
        var pointNo = that._getPointNo(event.target)
        that._addMarkers(pointNo, marker.getLatLng(), true, 0)
        setTimeout(function() {
          that._reloadPolyline()
          that._emit("leafletPolylineDragEnd", event)
        }, 25)
      })
      newPointMarker.on("contextmenu", function(event) {
        if (that._options.noSplit && that._options.noSplit === true) {
          return
        }
        // 1. Remove this polyline from map
        var marker = event.target
        var pointNo = that._getPointNo(marker)
        that._hideAll()

        var secondPartMarkers = that._markers.slice(pointNo, pointNo.length)
        that._markers.splice(pointNo, that._markers.length - pointNo)

        that._reloadPolyline()

        var points = []
        var contexts = []
        for (var i = 0; i < secondPartMarkers.length; i++) {
          var marker = secondPartMarkers[i]
          points.push(marker.getLatLng())
          contexts.push(marker.context)
        }

        // Need to know the current polyline order numbers, because
        // the splitted one need to be inserted immediately after:
        var originalPolylineNo = that._map._editablePolylines.indexOf(that)

        L.Polyline.PolylineEditor(points, that._options, contexts, originalPolylineNo + 1)
          .addTo(that._map)

        that._showBoundMarkers()
      })

      this._markers.splice(pointNo, 0, marker)

      // User-defined custom event listeners:
      if (that._options.customPointListeners) {
        for (var eventName in that._options.customPointListeners) { marker.on(eventName, that._options.customPointListeners[eventName]) }
      }
      if (that._options.customNewPointListeners) {
        for (var eventName in that._options.customNewPointListeners) { newPointMarker.on(eventName, that._options.customNewPointListeners[eventName]) }
      }

      if (fixNeighbourPositions) {
        this._fixAround(pointNo)
      }

      return marker
    }

    /**
     * Удаляет маркер точки и связанный с ним псевдомаркер.
     * Перерисовка карты не происходит в целях оптимизации
     */
    this._removeMarkers = function(marker) {
      var that = this
      that._map.removeLayer(marker.newPointMarker)
      that._map.removeLayer(marker)
    }

    /**
     * Обработчик события на первом или последнем маркере
     */
    this._prepareForNewPoint = function(marker, pointNo) {
      setTimeout(
        function() {
          that._hideAll()

          let firstPoint = null
          if (that._options.polygonMode && that._markers.length > 1) {
            firstPoint = pointNo === 0
              ? that._markers[that._markers.length - 1].getLatLng()
              : that._markers[0].getLatLng()
          }

          that._setupDragLines(marker, firstPoint, marker.getLatLng())
          that._map.once("click", function(event) {
            if (that._chain === marker) {
              if (that._markers.length === 1) {
                pointNo += 1
              }
              const newMarker = that._addMarkers(pointNo, event.latlng, true)
              that._reloadPolyline()
              that._emit("leafletPolylineAddPoint", event)
              newMarker.fire(that._options.addFirstLastPointEvent)
            }
          })
        },
        100
      )
    }

    /**
     * Исправить положение псевдомаркеров рядом с добавленым маркером
     */
    this._fixAround = function(pointNoOrMarker) {
      if ((typeof pointNoOrMarker) === "number") {
        var pointNo = pointNoOrMarker
      } else {
        var pointNo = that._markers.indexOf(pointNoOrMarker)
      }

      if (pointNo < 0) return

      var previousMarker = pointNo === 0 ? null : that._markers[pointNo - 1]
      var marker = that._markers[pointNo]
      var nextMarker = pointNo < that._markers.length - 1 ? that._markers[pointNo + 1] : null
      if (marker && previousMarker) {
        marker.newPointMarker.setLatLng([(previousMarker.getLatLng().lat + marker.getLatLng().lat) / 2.0,
          (previousMarker.getLatLng().lng + marker.getLatLng().lng) / 2.0])
      }
      if (marker && nextMarker) {
        nextMarker.newPointMarker.setLatLng([(marker.getLatLng().lat + nextMarker.getLatLng().lat) / 2.0,
          (marker.getLatLng().lng + nextMarker.getLatLng().lng) / 2.0])
      }
    }

    /**
     * Найти порядковый номер маркера
     */
    this._getPointNo = function(marker) {
      for (var i = 0; i < this._markers.length; i++) {
        if (marker === this._markers[i] || marker === this._markers[i].newPointMarker) {
          return i
        }
      }
      return -1
    }

    /**
     * Получить координаты всех маркеров.
     */
    this._getMarkerLatLngs = function() {
      return this._markers.map(m => m.getLatLng())
    }

    /**
     * Create lines from marker to point or cursor
     */
    this._setupDragLines = function(marker, point1, point2) {
      var line1 = null
      var line2 = null
      if (point1) {
        line1 = L.polyline([marker.getLatLng(), point1], {
          dashArray: "5",
          weight: 2,
          color: that.options.color
        })
          .addTo(that._map)
      }
      if (point2) {
        line2 = L.polyline([marker.getLatLng(), point2], {
          dashArray: "5",
          weight: 2,
          color: that.options.color
        })
          .addTo(that._map)
      }

      var moveHandler = function(event) {
        if (line1) line1.setLatLngs([event.latlng, point1])
        if (line2) line2.setLatLngs([event.latlng, point2])
      }

      var stopHandler = function(event) {
        if (that._map) {
          that._map.off("mousemove", moveHandler)
          marker.off("dragend", stopHandler)
          if (line1) that._map.removeLayer(line1)
          if (line2) that._map.removeLayer(line2)
          if (event.target !== that._map) {
            that._map.fire("click", event)
          }
        }
      }

      var cancelHandler = function(event) {
        if (that._map) {
          that._map.off("mousemove", moveHandler)
          marker.off("dragend", stopHandler)
          if (line1) that._map.removeLayer(line1)
          if (line2) that._map.removeLayer(line2)
        }
      }

      that._map.on("mousemove", moveHandler)
      marker.on("dragend", stopHandler)

      that._map.once("click", stopHandler)
      that._map.once("contextmenu", cancelHandler)
      that._map.once("mouseout", cancelHandler)
      marker.once("click", stopHandler)
      if (line1) line1.once("click", stopHandler)
      if (line2) line2.once("click", stopHandler)
    }

    /**
     * Идентификатор компонента для полилинии
     */
    this.getID = function() {
      return this._uid
    }

    /**
     * Установить точки и маркеры для полилинии
     */
    this.setPoints = function(editablePoints, options, contexts) {
      // Обновляем опции, если переданы
      if (options) {
        that._parseOptions(options)
        that.setStyle(options)
      }

      // Обновляем точки на полилиниии
      if (editablePoints.length > 0) {
        that.setLatLngs(editablePoints.map(p => [p.lat, p.lng]))
      } else {
        that.setLatLngs([])
      }

      that._contexts = contexts || null
      that._setMarkersOnPoints()

      // Обновляем полилинию
      that._reloadPolyline()

      // Если это первая точка и добавление идет цепочкой
      if (that._markers.length === 1 && that._options.chainedAdding === true) {
        that._markers[0].fire("click")
      }
    }

    /**
     * Скрывает точки и делает полилинию неактивной
     */
    this.hidePoints = function() {
      this._chain = false
      this._disabled = true
      for (var i in this._markers) {
        var marker = this._markers[i]
        this._setMarkerVisible(marker, false)
        this._setMarkerVisible(marker.newPointMarker, false)
      }
    }

    /**
     * Показывает точки и делает полилинию активной
     */
    this.showPoints = function() {
      this._chain = false
      this._disabled = false
      this._showBoundMarkers(this.getID())
    }

    /**
     * Возбуждает пользовательское событие
     * @param eventName
     * @param parent
     * @private
     */
    this._emit = function(eventName, parent) {
      var customEvent = Object.assign({ detail: { points: that._getMarkerLatLngs(), uid: that._uid } }, parent)
      document.dispatchEvent(new CustomEvent(eventName, customEvent))
    }
  }
})

L.Polyline.polylineEditor.addInitHook(function() {
  this.on("add", function(event) {
    this._map = event.target._map
    this._addMethods()

    /**
     * When adding a new point we must disable the user to mess with other
     * markers. One way is to check everywhere if the user is busy. The
     * other is to just remove other markers when the user is doing
     * something.
     *
     * TODO: Decide the right way to do this and then leave only _busy or
     * _hideAll().
     */
    this._setBusy(true)
    this._initialized = false

    this._init(this._options, this._contexts)

    this._setBusy(false)
    this._initialized = true
    this._showBoundMarkers()

    return this
  })

  this.on("remove", function(event) {
    var polyline = event.target
    var map = polyline._map
    var polylines = map.getEditablePolylines()
    var index = polylines.indexOf(polyline)
    if (index > -1) {
      polylines[index]._markers.forEach(function(marker) {
        map.removeLayer(marker)
        if (marker.newPointMarker) map.removeLayer(marker.newPointMarker)
      })
      polylines.splice(index, 1)
    }
  })
})

/**
 * Конструктор новой редактируемой полилинии
 *
 * @latlngs array     массив точек
 * @contexts array    массив доп. данных для каждой точки. Номер в массиве, должен совпадать с номером точки в latlngs
 *                    данные сохряняются при добавлении новых точек или разделении линии.
 * @options object    опции полилинии (поддерживаются опции Leaflet Polyline)
 * @polylineNo int   уникальный номер для полилинии (используется при разделении).
 * @polylineName string идентефикатор полилинии.
 *
 * Подробнее о contexts:
 * Это массив объектов к элементу которого можно обратиться через поле "context" у каждой точки
 * У созданных точек значение context = null.
 *
 * Массив context должен быть того же размера что и массив точек!
 *
 * По умолчанию каждый маркер имеет поле context с одним значением:
 * marker.context.originalPointNo в нем хранится начальный номер точки
 * т.к. номер точки может изменится если были добавлены/удалены точки перед/после
 *
 */
L.Polyline.PolylineEditor = function(latlngs, options, contexts, polylineNo) {
  // Since the app code may not be able to explicitly call the
  // initialization of all editable polylines (if the user created a new
  // one by splitting an existing), with this method you can control the
  // options for new polylines:
  if (options.prepareOptions) {
    options.prepareOptions(options)
  }

  var result = new L.Polyline.polylineEditor(latlngs, options)
  result._options = options
  result._contexts = contexts
  result._desiredPolylineNo = polylineNo
  result._uid = options.uid || null
  result._disabled = false

  return result
}
