import {EntitySubscriberInterface, EventSubscriber, InsertEvent} from 'typeorm';
import {Notification} from '../entity/Notification';
import EventEmitter from 'events';

export const emitter = new EventEmitter();

@EventSubscriber()
export class PostSubscriber implements EntitySubscriberInterface<Notification> {
	listenTo() {
		return Notification;
	}
	beforeInsert(event: InsertEvent<Notification>) {
		emitter.emit('notification', event.entity);
	}
}
