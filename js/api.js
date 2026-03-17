/* ==================== API MODULE ==================== */
/* Отвечает за все HTTP-запросы к внешним системам */

const API = {
  /**
   * Авторизация через хук
   * @param {Object} userData - Данные пользователя из Telegram
   * @returns {Promise<Array|null>} Массив пользователей или null
   */
  async authorize(userData) {
    const hookUrl = 'https://quumahienot.beget.app/webhook/lk-ps';
    const payload = {
      date: "auth",
      user_id: userData?.id || null,
      username: userData?.username || null,
      first_name: userData?.first_name || null,
      last_name: userData?.last_name || null
    };

    try {
      console.log('📤 [API] Отправляем запрос авторизации:', payload);
      
      const response = await fetch(hookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();
      console.log('✅ [API] Ответ от хука:', result);
      return result;

    } catch (error) {
      console.error('❌ [API] Ошибка авторизации:', error);
      return null;
    }
  },

  /**
   * Отправка данных QR-кода в вебхук
   * @param {string} qrData - Строка из QR-кода (обычно URL)
   * @param {Object} userData - Данные пользователя из Telegram
   * @returns {Promise<any|null>} Ответ вебхука или null
   */
  async sendQrData(qrData, userData) {
    const hookUrl = 'https://quumahienot.beget.app/webhook/lk-ps';
    const userDataWithoutPhoto = Object.fromEntries(
      Object.entries(userData || {}).filter(
        ([key]) => !['photo_url', 'photo', 'avatar', 'avatar_url'].includes(key)
      )
    );

    const payload = {
      date: "qr",
      qr_data: qrData,
      user_id: userData?.id || null,
      username: userData?.username || null,
      first_name: userData?.first_name || null,
      last_name: userData?.last_name || null,
      tg_user: userDataWithoutPhoto
    };

    try {
      console.log('📤 [API] Отправляем QR в вебхук:', payload);
      
      const response = await fetch(hookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json().catch(() => null);
      console.log('✅ [API] QR успешно отправлен, ответ:', result);
      return result;

    } catch (error) {
      console.error('❌ [API] Ошибка отправки QR:', error);
      return null;
    }
  }
  ,

  /**
   * Второй вебхук: передаем массив заведений [{Client, ID}]
   * @param {Array|Object} establishmentsPayload - Массив или один объект {Client, ID}
   * @param {Object|null} userData - Данные пользователя Telegram
   * @returns {Promise<any|null>} Ответ вебхука или null
   */
  async sendTaskSupport(establishmentsPayload, userData = null) {
    const hookUrl = 'https://quumahienot.beget.app/webhook/task_support';
    const basePayload = Array.isArray(establishmentsPayload)
      ? establishmentsPayload
      : (establishmentsPayload ? [establishmentsPayload] : []);
    const payload = basePayload
      .map((item) => {
        const client = item?.Client ?? item?.client ?? item?.name ?? null;
        const id = item?.ID ?? item?.Id ?? item?.id ?? null;
        const number = item?.Nubmer ?? item?.Number ?? item?.number ?? null;

        if (!client || !id) return null;

        return {
          Client: String(client),
          ID: String(id),
          ...(number ? { Nubmer: String(number) } : {}),
          Iduser: userData?.id || null
        };
      })
      .filter(Boolean);

    if (payload.length === 0) {
      console.warn('⚠️ [API] task_support не отправлен: нет валидных Client/ID');
      return null;
    }

    try {
      console.log('📤 [API] Отправляем task_support:', payload);

      const response = await fetch(hookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json().catch(() => null);
      console.log('✅ [API] Ответ task_support:', result);
      return result;

    } catch (error) {
      console.error('❌ [API] Ошибка task_support:', error);
      return null;
    }
  }

  ,

  /**
   * Проверка открытых задач по заведениям
   * @param {Array|Object} establishmentsPayload - Массив или один объект {Client, ID}
   * @param {Object|null} userData - Данные пользователя Telegram
   * @returns {Promise<any|null>} Ответ вебхука или null
   */
  async sendOpenTask(establishmentsPayload, userData = null) {
    const hookUrl = 'https://quumahienot.beget.app/webhook/open_task';
    const basePayload = Array.isArray(establishmentsPayload)
      ? establishmentsPayload
      : (establishmentsPayload ? [establishmentsPayload] : []);
    const payload = basePayload
      .map((item) => {
        const client = item?.Client ?? item?.client ?? item?.name ?? null;
        const id = item?.ID ?? item?.Id ?? item?.id ?? null;

        if (!client || !id) return null;

        return {
          Client: String(client),
          ID: String(id),
          Iduser: userData?.id || null
        };
      })
      .filter(Boolean);

    if (payload.length === 0) {
      console.warn('⚠️ [API] open_task не отправлен: нет валидных Client/ID');
      return null;
    }

    try {
      console.log('📤 [API] Отправляем open_task:', payload);

      const response = await fetch(hookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json().catch(() => null);
      console.log('✅ [API] Ответ open_task:', result);
      return result;
    } catch (error) {
      console.error('❌ [API] Ошибка open_task:', error);
      return null;
    }
  }

  ,

  /**
   * Загрузка истории диалога по задаче
   * @param {Object} chatPayload - Данные задачи/чата
   * @param {Object|null} userData - Данные пользователя Telegram
   * @param {Object|null} webApp - Telegram WebApp
   * @returns {Promise<any|null>} Ответ вебхука или null
   */
  async sendOpenChat(chatPayload = {}, userData = null, webApp = null) {
    const hookUrl = 'https://quumahienot.beget.app/webhook/open_chat';
    const payload = {
      task_id: chatPayload?.task_id ?? chatPayload?.taskId ?? null,
      chat_id: chatPayload?.chat_id ?? chatPayload?.chatId ?? null,
      org: chatPayload?.org ?? null,
      Client: chatPayload?.Client ?? chatPayload?.org ?? null,
      ID: chatPayload?.ID ?? chatPayload?.establishment_id ?? null,
      user_id: userData?.id || null,
      username: userData?.username || null,
      first_name: userData?.first_name || null,
      last_name: userData?.last_name || null,
      tg_init_data: webApp?.initData || null
    };

    try {
      console.log('📤 [API] Отправляем open_chat:', payload);

      const response = await fetch(hookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json().catch(() => null);
      console.log('✅ [API] Ответ open_chat:', result);
      return result;
    } catch (error) {
      console.error('❌ [API] Ошибка open_chat:', error);
      return null;
    }
  }

  ,

  /**
   * Отправка сообщения из миниаппа в диалог заявки
   * @param {Object} messagePayload - Данные сообщения/задачи
   * @param {Object|null} userData - Данные пользователя Telegram
   * @param {Object|null} webApp - Telegram WebApp
   * @param {File[]|Array|null} files - Прикрепленные файлы
   * @returns {Promise<any|null>} Ответ вебхука или null
   */
  async sendMiniappMessage(messagePayload = {}, userData = null, webApp = null, files = []) {
    const hookUrl = 'https://quumahienot.beget.app/webhook/message_miniapp';
    const textValue = messagePayload?.text ?? null;
    const messageType = messagePayload?.message_type ?? messagePayload?.messageType ?? 'text';
    const fileName = messagePayload?.file_name ?? messagePayload?.fileName ?? null;
    const payload = {
      task_id: messagePayload?.task_id ?? messagePayload?.taskId ?? null,
      chat_id: messagePayload?.chat_id ?? messagePayload?.chatId ?? null,
      org: messagePayload?.org ?? null,
      Client: messagePayload?.Client ?? messagePayload?.org ?? null,
      ID: messagePayload?.ID ?? messagePayload?.establishment_id ?? null,
      text: textValue,
      message: textValue,
      comment: textValue,
      body: textValue,
      message_type: messageType,
      file_name: fileName,
      message_payload: {
        text: textValue,
        message: textValue,
        comment: textValue,
        body: textValue,
        message_type: messageType,
        file_name: fileName
      },
      user_id: userData?.id || null,
      username: userData?.username || null,
      first_name: userData?.first_name || null,
      last_name: userData?.last_name || null,
      tg_init_data: webApp?.initData || null
    };

    try {
      console.log('📤 [API] Отправляем message_miniapp:', payload);

      const preparedFiles = Array.isArray(files) ? files.filter(Boolean) : [];
      const hasFiles = preparedFiles.length > 0;
      let response;

      if (hasFiles) {
        const formData = new FormData();
        Object.entries(payload).forEach(([key, value]) => {
          if (value === undefined || value === null) return;
          if (typeof value === 'object') {
            formData.append(key, JSON.stringify(value));
            return;
          }
          formData.append(key, String(value));
        });
        preparedFiles.forEach((file) => {
          formData.append('files', file, file.name);
        });

        response = await fetch(hookUrl, {
          method: 'POST',
          headers: {
            'Accept': 'application/json'
          },
          body: formData
        });
      } else {
        response = await fetch(hookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify(payload)
        });
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json().catch(() => null);
      console.log('✅ [API] Ответ message_miniapp:', result);
      return result;
    } catch (error) {
      console.error('❌ [API] Ошибка message_miniapp:', error);
      return null;
    }
  }

  ,

  /**
   * При открытии страницы отправляем данные пользователя Telegram в вебхук
   * @param {Object} userData - tg.initDataUnsafe.user
   * @param {Object} webApp - window.Telegram.WebApp
   * @returns {Promise<any|null>}
   */
  async sendClientTGSupport(userData, webApp) {
    const hookUrl = 'https://quumahienot.beget.app/webhook/clientTG_support';
    const userDataWithoutPhoto = Object.fromEntries(
      Object.entries(userData || {}).filter(
        ([key]) => !['photo_url', 'photo', 'avatar', 'avatar_url'].includes(key)
      )
    );

    // Берем максимально полезные данные, но оставляем payload JSON-safe
    const payload = {
      date: 'clientTG_support',
      user_id: userData?.id || null,
      username: userData?.username || null,
      first_name: userData?.first_name || null,
      last_name: userData?.last_name || null,
      tg_user: userDataWithoutPhoto,
      tg_init_data: webApp?.initData || null,
      tg_platform: webApp?.platform || null,
      tg_version: webApp?.version || null,
      tg_color_scheme: webApp?.colorScheme || null
    };

    try {
      console.log('📤 [API] Отправляем clientTG_support:', payload);

      const response = await fetch(hookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json().catch(() => null);
      console.log('✅ [API] Ответ clientTG_support:', result);
      return result;
    } catch (error) {
      console.error('❌ [API] Ошибка clientTG_support:', error);
      return null;
    }
  }

  ,

  /**
   * Регистрация клиента после предоставления номера телефона
   * @param {Object} contact - объект контакта (ожидается phone_number)
   * @param {Object} userData - tg.initDataUnsafe.user
   * @param {Object} webApp - window.Telegram.WebApp
   * @returns {Promise<any|null>}
   */
  async sendRegistrClient(contact, userData, webApp, meta = null) {
    const hookUrl = 'https://quumahienot.beget.app/webhook/registr_client';
    const userDataWithoutPhoto = Object.fromEntries(
      Object.entries(userData || {}).filter(
        ([key]) => !['photo_url', 'photo', 'avatar', 'avatar_url'].includes(key)
      )
    );

    const payload = {
      date: 'registr_client',
      phone_number: contact?.phone_number || null,
      meta: meta || null,
      user_id: userData?.id || null,
      username: userData?.username || null,
      first_name: userData?.first_name || null,
      last_name: userData?.last_name || null,
      tg_user: userDataWithoutPhoto,
      tg_init_data: webApp?.initData || null,
      tg_platform: webApp?.platform || null,
      tg_version: webApp?.version || null
    };

    try {
      console.log('📤 [API] Отправляем registr_client:', payload);

      const response = await fetch(hookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json().catch(() => null);
      console.log('✅ [API] Ответ registr_client:', result);
      return result;
    } catch (error) {
      console.error('❌ [API] Ошибка registr_client:', error);
      return null;
    }
  },

  /**
   * Создание новой заявки в TaskV2
   * @param {Object} taskData - Данные заявки из UI
   * @param {Object} userData - tg.initDataUnsafe.user
   * @param {Object} webApp - window.Telegram.WebApp
   * @returns {Promise<any|null>}
   */
  async createTaskV2(taskData = {}, userData, webApp, files = []) {
    const hookUrl = 'https://quumahienot.beget.app/webhook/TaskV2';
    const userDataWithoutPhoto = Object.fromEntries(
      Object.entries(userData || {}).filter(
        ([key]) => !['photo_url', 'photo', 'avatar', 'avatar_url'].includes(key)
      )
    );

    const payload = {
      date: 'task_v2',
      user_id: userData?.id || null,
      username: userData?.username || null,
      first_name: userData?.first_name || null,
      last_name: userData?.last_name || null,
      tg_user: userDataWithoutPhoto,
      tg_init_data: webApp?.initData || null,
      tg_platform: webApp?.platform || null,
      tg_version: webApp?.version || null,
      task: taskData,
      ...taskData
    };

    try {
      console.log('📤 [API] Отправляем TaskV2:', payload);
      const preparedFiles = Array.isArray(files) ? files.filter(Boolean) : [];
      const hasFiles = preparedFiles.length > 0;

      let response;
      if (hasFiles) {
        const formData = new FormData();
        Object.entries(payload).forEach(([key, value]) => {
          if (value === undefined || value === null) return;
          if (typeof value === 'object') {
            formData.append(key, JSON.stringify(value));
            return;
          }
          formData.append(key, String(value));
        });

        preparedFiles.forEach((file) => {
          formData.append('files', file, file.name);
        });

        response = await fetch(hookUrl, {
          method: 'POST',
          headers: {
            'Accept': 'application/json'
          },
          body: formData
        });
      } else {
        response = await fetch(hookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify(payload)
        });
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json().catch(() => null);
      console.log('✅ [API] Ответ TaskV2:', result);
      return result;
    } catch (error) {
      console.error('❌ [API] Ошибка TaskV2:', error);
      return null;
    }
  }
};

// Экспортируем модуль
window.API = API;
